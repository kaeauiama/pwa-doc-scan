import { binarize } from "./core/binarize.ts";
import { CONFIG, paperPixels } from "./core/config.ts";
import { detectDocumentQuad } from "./core/detect.ts";
import { rgbaToGray } from "./core/gray.ts";
import { bilevelPage, encodePdf, jpegPage } from "./core/pdf.ts";
import { encodePng1bit } from "./core/png.ts";
import { estimateOutputSize, insetQuad, warpGray, warpRgba } from "./core/warp.ts";
import { whitenBackground } from "./core/whiten.ts";
import type { BinarizeMethod } from "./core/binarize.ts";
import type { DetectResult } from "./core/detect.ts";
import type { PdfPage } from "./core/pdf.ts";
import type { Bilevel, Quad, Rgba } from "./core/types.ts";
import type { JpegEncoder } from "./ports/JpegEncoder.ts";

/** 作成物の形式(REQ-22)。PDF か、そのまま扱える画像か。 */
export type OutputFormat = "pdf" | "image";

export interface EncodedOutput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly extension: string;
  /** 利用者に見せる短い説明 */
  readonly label: string;
}

/** 出力モード(REQ-20)。既定は書類向けの白黒2値。 */
export type RenderMode = "color" | "grayscale" | "bilevel";

export interface ScanOptions {
  mode?: RenderMode;
  dpi?: number;
  /** 四隅。省略すると自動検出する。手動調整の結果を渡す場合はここに入れる(REQ-03) */
  quad?: Quad;
  /** カラー / グレースケールで背景を白に寄せるか(REQ-21) */
  whiten?: boolean;
  jpegQuality?: number;
  binarizeMethod?: BinarizeMethod;
  /**
   * 切り出す前に四隅を内側へ詰める割合。既定 0.6%。
   * 検出した縁のわずか外側に机が入り、白飛ばしや二値化が汚れを作るのを防ぐ。
   * 0 にすると詰めない。
   */
  inset?: number;
}

/** 画面に出すための処理後画像。モードによって型が変わる */
export type ProcessedImage =
  | { readonly kind: "bilevel"; readonly image: Bilevel }
  | { readonly kind: "rgba"; readonly image: Rgba };

export interface ScanResult {
  readonly page: PdfPage;
  readonly processed: ProcessedImage;
  readonly quad: Quad;
  /** 自動検出を使った場合のみ。手動の四隅を渡したときは null */
  readonly detection: DetectResult | null;
  readonly mode: RenderMode;
  readonly dpi: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
}

export const DEFAULTS = {
  mode: "bilevel" as RenderMode,
  whiten: true,
  jpegQuality: 0.82,
  inset: 0.006,
} as const;

/** 画像全体を四隅として扱う(検出に失敗したときの素直な既定) */
export function fullFrameQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/**
 * 出力サイズを決める。四隅の縦横比を保ったまま、長辺が
 * 「A4 を指定 DPI で出したときの長辺」に収まるよう縮める。
 *
 * A4 に決め打ちで正規化しないのは、レシートや名刺のように比率が違う原稿でも
 * 破綻させないため。A4 相当が上限になるだけで、比率は原稿のまま。
 */
export function outputSizeFor(quad: Quad, dpi: number): { width: number; height: number } {
  const a4 = paperPixels(CONFIG.paper.a4.widthMm, CONFIG.paper.a4.heightMm, dpi);
  return estimateOutputSize(quad, Math.max(a4.width, a4.height));
}

function toRgbaFromGray(gray: { width: number; height: number; data: Uint8Array }): Rgba {
  const out = new Uint8ClampedArray(gray.width * gray.height * 4);
  for (let i = 0, j = 0; i < gray.data.length; i++, j += 4) {
    const v = gray.data[i];
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
    out[j + 3] = 255;
  }
  return { width: gray.width, height: gray.height, data: out };
}

/**
 * 撮影した 1 枚を PDF の 1 ページに変換する。
 *
 * 四隅を渡さなければ自動検出する。検出に失敗した場合は画像全体を四隅として扱い、
 * `detection` に失敗の理由コードを残す(REQ-14: 沈黙で失敗しない)。
 * 呼び出し側は `detection.ok === false` や低い `confidence` を見て、
 * 手動での四隅調整(REQ-03)を促すこと。
 */
export async function scanToPage(
  frame: Rgba,
  options: ScanOptions,
  jpeg: JpegEncoder,
): Promise<ScanResult> {
  const mode = options.mode ?? DEFAULTS.mode;
  const dpi = options.dpi ?? CONFIG.output.defaultDpi;
  const whiten = options.whiten ?? DEFAULTS.whiten;
  const quality = options.jpegQuality ?? DEFAULTS.jpegQuality;

  const gray = rgbaToGray(frame);

  let detected: Quad;
  let detection: DetectResult | null = null;
  if (options.quad) {
    detected = options.quad;
  } else {
    detection = detectDocumentQuad(gray);
    detected = detection.ok ? detection.quad : fullFrameQuad(frame.width, frame.height);
  }
  const quad = insetQuad(detected, options.inset ?? DEFAULTS.inset);

  const size = outputSizeFor(quad, dpi);

  if (mode === "bilevel") {
    const warped = warpGray(gray, quad, size.width, size.height);
    const bw = binarize(warped, { method: options.binarizeMethod });
    return {
      page: bilevelPage(bw, dpi),
      processed: { kind: "bilevel", image: bw },
      quad,
      detection,
      mode,
      dpi,
      outputWidth: size.width,
      outputHeight: size.height,
    };
  }

  let image: Rgba;
  if (mode === "grayscale") {
    const warped = warpGray(gray, quad, size.width, size.height);
    const base = toRgbaFromGray(warped);
    image = whiten ? whitenBackground(base) : base;
  } else {
    const warped = warpRgba(frame, quad, size.width, size.height);
    image = whiten ? whitenBackground(warped) : warped;
  }

  const bytes = await jpeg.encode(image, quality);
  return {
    page: jpegPage(bytes, image.width, image.height, dpi, "DeviceRGB"),
    processed: { kind: "rgba", image },
    quad,
    detection,
    mode,
    dpi,
    outputWidth: size.width,
    outputHeight: size.height,
  };
}


/**
 * 処理結果をファイルのバイト列にする。
 *
 * 画像形式は再エンコードしない。カラー / グレースケールは `scanToPage` が作った
 * JPEG をそのまま返し、白黒2値は 1bit PNG にする。
 * 白黒2値を JPEG にすると輪郭にリンギングが出るうえサイズも増えるため、選ばせない。
 */
export async function encodeOutput(result: ScanResult, format: OutputFormat): Promise<EncodedOutput> {
  if (format === "pdf") {
    return {
      bytes: await encodePdf([result.page]),
      mimeType: "application/pdf",
      extension: "pdf",
      label: "PDF",
    };
  }
  if (result.page.image.kind === "jpeg") {
    return {
      bytes: result.page.image.bytes,
      mimeType: "image/jpeg",
      extension: "jpg",
      label: "JPEG 画像",
    };
  }
  if (result.page.image.kind === "bilevel") {
    return {
      bytes: await encodePng1bit(result.page.image.image, result.dpi),
      mimeType: "image/png",
      extension: "png",
      label: "PNG 画像(1bit)",
    };
  }
  // 圧縮済みのページ(compactPage 済み)からは PNG を組み直せない。
  // PNG は行ごとにフィルタバイトが要るため、PDF 用の圧縮結果を流用できない。
  throw new Error("圧縮済みのページは画像として書き出せません。PDF を選んでください。");
}
