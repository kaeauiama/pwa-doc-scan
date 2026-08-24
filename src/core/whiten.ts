import { buildIntegral, rectSum } from "./integral.ts";
import type { Rgba } from "./types.ts";

export interface WhitenOptions {
  /** 局所窓のサイズ = 長辺 / windowDivisor */
  windowDivisor?: number;
  /** 紙の白をどの明るさに持ち上げるか */
  whiteLevel?: number;
  /**
   * 上限倍率。ノイズを増幅しすぎないための歯止め。
   * 低すぎると強い影の中で紙を白に戻しきれず、ムラが残る。
   */
  maxGain?: number;
  /**
   * 黒点。ゲインを掛けたあとに (v - blackPoint) を whiteLevel まで引き伸ばす。
   * これが無いと倍率がインクにも等しく掛かり、紙と一緒にインクまで明るくなって
   * 「明るいだけの写真」になる。0 にすると無効。
   */
  blackPoint?: number;
}

const DEFAULTS = { windowDivisor: 8, whiteLevel: 245, maxGain: 6, blackPoint: 26 } as const;

/**
 * 背景の白飛ばし。カラー / グレースケール出力を「スキャンらしく」する(D-027・REQ-21)。
 *
 * 素の写真をそのまま PDF にすると、紙が灰色や黄色に写って書類に見えない。
 * 局所的な明るさ(輝度の局所平均)を紙の白と見なし、その平均が whiteLevel になるよう
 * RGB を一律に持ち上げる。色の比率は変えないので、チラシの色は保たれる。
 * そのあと黒点で引き伸ばし、紙を白に振り切らせつつインクを暗いまま残す。
 * 倍率だけだとインクも同じ率で明るくなり、洗いざらしの写真になる。
 *
 * 二値化で使っている照明の平坦化(D-015)と同じ考え方だが、
 * あちらは輝度を 128 に正規化してエッジ検出用に潰すのに対し、
 * こちらは色を保ったまま紙だけを白に寄せる。
 */
export function whitenBackground(src: Rgba, options: WhitenOptions = {}): Rgba {
  const opt = { ...DEFAULTS, ...options };
  const { width, height, data } = src;
  const n = width * height;

  // 局所平均は輝度に対して求める(チャンネルごとに求めると色かぶりが消えすぎる)
  const luma = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    luma[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }

  const win = Math.max(31, Math.floor(Math.max(width, height) / opt.windowDivisor)) | 1;
  const r = win >> 1;
  const integral = buildIntegral(luma, width, height, false);
  const iw = width + 1;
  const out = new Uint8ClampedArray(n * 4);
  const stretch = opt.blackPoint > 0 ? 255 / (opt.whiteLevel - opt.blackPoint) : 255 / opt.whiteLevel;

  for (let y = 0; y < height; y++) {
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r >= height ? height - 1 : y + r;
    for (let x = 0; x < width; x++) {
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r >= width ? width - 1 : x + r;
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const mean = rectSum(integral.sum, iw, x0, y0, x1, y1) / area;

      let gain = mean < 1 ? opt.maxGain : opt.whiteLevel / mean;
      if (gain > opt.maxGain) gain = opt.maxGain;
      if (gain < 1) gain = 1; // 元より暗くはしない

      const i = (y * width + x) * 4;
      out[i] = (data[i] * gain - opt.blackPoint) * stretch;
      out[i + 1] = (data[i + 1] * gain - opt.blackPoint) * stretch;
      out[i + 2] = (data[i + 2] * gain - opt.blackPoint) * stretch;
      out[i + 3] = 255;
    }
  }
  return { width, height, data: out };
}
