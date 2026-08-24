import { CONFIG } from "./config.ts";
import { concatBytes, deflateZlib } from "./deflate.ts";
import { packBits } from "./pack.ts";
import type { Bilevel } from "./types.ts";

const ASCII = new TextEncoder();
const PT_PER_INCH = 72;

export interface PdfPage {
  readonly image: Bilevel;
  /** この画像を何 DPI として配置するか。ページの物理サイズがこれで決まる */
  readonly dpi?: number;
}

/**
 * 1bit 画像を FlateDecode で埋めた PDF を生成する。外部ライブラリに依存しない。
 *
 * オブジェクト構成:
 *   1        Catalog
 *   2        Pages
 *   3+3i     Page i
 *   4+3i     Image XObject i
 *   5+3i     Contents i
 */
export async function encodePdf1bit(pages: readonly PdfPage[]): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error("encodePdf1bit: ページが空です");

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
    const { image } = pages[i];
    const dpi = pages[i].dpi ?? CONFIG.output.defaultDpi;
    const pageObj = 3 + i * 3;
    const imgObj = pageObj + 1;
    const contentObj = pageObj + 2;

    const widthPt = (image.width / dpi) * PT_PER_INCH;
    const heightPt = (image.height / dpi) * PT_PER_INCH;
    const compressed = await deflateZlib(packBits(image, false));

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
        ` /Width ${image.width} /Height ${image.height}` +
        ` /ColorSpace /DeviceGray /BitsPerComponent 1` +
        ` /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
    );
    push(compressed);
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
