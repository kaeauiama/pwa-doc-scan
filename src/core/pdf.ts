import { CONFIG } from "./config.ts";
import { concatBytes, deflateZlib } from "./deflate.ts";
import { packBits } from "./pack.ts";
import type { Bilevel } from "./types.ts";

const ASCII = new TextEncoder();
const PT_PER_INCH = 72;

/**
 * PDF に埋める画像。
 *
 * - `bilevel` : 1bit + FlateDecode。書類の白黒2値。A4 200dpi で 40〜50KB
 * - `bilevel-flate` : 上を圧縮済みにしたもの。複数ページを保持するときに使う。
 *   生の Bilevel は 1 画素 1 バイトで A4 200dpi 1 枚が約 3.9MB あり、
 *   何枚も抱えると端末が落ちる。圧縮済みなら 1 枚 40〜50KB で済む
 * - `jpeg`    : エンコード済みの JPEG を `/DCTDecode` でそのまま埋める。
 *               カラー / グレースケール用(D-026)。
 *
 * JPEG の生成はブラウザの canvas に依存するため、ここでは**バイト列を受け取るだけ**にして
 * `core/` を純粋なまま保つ。エンコードはアダプタ(`CanvasJpegEncoder`)の仕事。
 */
export type PdfImage =
  | { readonly kind: "bilevel"; readonly image: Bilevel }
  | {
      readonly kind: "bilevel-flate";
      /** packBits + zlib deflate 済みのバイト列 */
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "jpeg";
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
      /**
       * canvas が出す JPEG は常に 3 チャンネルなので、見た目がグレーでも DeviceRGB。
       * 真のグレースケール JPEG を渡せる場合だけ DeviceGray にすること。
       */
      readonly colorSpace?: "DeviceRGB" | "DeviceGray";
    };

export interface PdfPage {
  readonly image: PdfImage;
  /** この画像を何 DPI として配置するか。ページの物理サイズがこれで決まる */
  readonly dpi?: number;
}

export function bilevelPage(image: Bilevel, dpi?: number): PdfPage {
  return { image: { kind: "bilevel", image }, dpi };
}

/**
 * ページを保持しやすい形にする。白黒2値だけが対象で、それ以外はそのまま返す。
 * 出来上がる PDF のバイト列は変換前と完全に同じになる。
 */
export async function compactPage(page: PdfPage): Promise<PdfPage> {
  if (page.image.kind !== "bilevel") return page;
  const image = page.image.image;
  return {
    image: {
      kind: "bilevel-flate",
      bytes: await deflateZlib(packBits(image, false)),
      width: image.width,
      height: image.height,
    },
    dpi: page.dpi,
  };
}

export function jpegPage(
  bytes: Uint8Array,
  width: number,
  height: number,
  dpi?: number,
  colorSpace: "DeviceRGB" | "DeviceGray" = "DeviceRGB",
): PdfPage {
  return { image: { kind: "jpeg", bytes, width, height, colorSpace }, dpi };
}

interface EncodedImage {
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly filter: string;
  readonly colorSpace: string;
  readonly bitsPerComponent: number;
}

async function prepare(image: PdfImage): Promise<EncodedImage> {
  if (image.kind === "bilevel-flate") {
    return {
      width: image.width,
      height: image.height,
      bytes: image.bytes,
      filter: "/FlateDecode",
      colorSpace: "/DeviceGray",
      bitsPerComponent: 1,
    };
  }
  if (image.kind === "bilevel") {
    return {
      width: image.image.width,
      height: image.image.height,
      bytes: await deflateZlib(packBits(image.image, false)),
      filter: "/FlateDecode",
      colorSpace: "/DeviceGray",
      bitsPerComponent: 1,
    };
  }
  return {
    width: image.width,
    height: image.height,
    bytes: image.bytes,
    filter: "/DCTDecode",
    colorSpace: `/${image.colorSpace ?? "DeviceRGB"}`,
    bitsPerComponent: 8,
  };
}

/**
 * PDF を生成する。外部ライブラリに依存しない。
 *
 * オブジェクト構成:
 *   1        Catalog
 *   2        Pages
 *   3+3i     Page i
 *   4+3i     Image XObject i
 *   5+3i     Contents i
 */
export async function encodePdf(pages: readonly PdfPage[]): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error("encodePdf: ページが空です");

  const parts: Uint8Array[] = [];
  let len = 0;
  const push = (b: Uint8Array) => {
    parts.push(b);
    len += b.length;
  };
  const s = (str: string) => push(ASCII.encode(str));

  /** offsets[objNumber] = ファイル先頭からのバイト位置 */
  const offsets: number[] = [];
  const objCount = 2 + pages.length * 3;

  s("%PDF-1.4\n");
  // バイナリを含むことを示す慣例のコメント行
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  offsets[1] = len;
  s("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  offsets[2] = len;
  s(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  for (let i = 0; i < pages.length; i++) {
    const dpi = pages[i].dpi ?? CONFIG.output.defaultDpi;
    const encoded = await prepare(pages[i].image);
    const pageObj = 3 + i * 3;
    const imgObj = pageObj + 1;
    const contentObj = pageObj + 2;

    const widthPt = (encoded.width / dpi) * PT_PER_INCH;
    const heightPt = (encoded.height / dpi) * PT_PER_INCH;

    offsets[pageObj] = len;
    s(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R` +
        ` /MediaBox [0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)}]` +
        ` /Resources << /XObject << /Im0 ${imgObj} 0 R >> >>` +
        ` /Contents ${contentObj} 0 R >>\nendobj\n`,
    );

    offsets[imgObj] = len;
    s(
      `${imgObj} 0 obj\n<< /Type /XObject /Subtype /Image` +
        ` /Width ${encoded.width} /Height ${encoded.height}` +
        ` /ColorSpace ${encoded.colorSpace} /BitsPerComponent ${encoded.bitsPerComponent}` +
        ` /Filter ${encoded.filter} /Length ${encoded.bytes.length} >>\nstream\n`,
    );
    push(encoded.bytes);
    s("\nendstream\nendobj\n");

    const content = `q ${widthPt.toFixed(2)} 0 0 ${heightPt.toFixed(2)} 0 0 cm /Im0 Do Q\n`;
    offsets[contentObj] = len;
    s(`${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  }

  const xrefPos = len;
  let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objCount; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  s(xref);
  s(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return concatBytes(parts);
}
