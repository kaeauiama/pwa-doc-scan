import { CONFIG } from "./config.ts";
import { buildIntegral, rectSum } from "./integral.ts";
import type { Bilevel, Gray8 } from "./types.ts";

export type BinarizeMethod = "sauvola" | "bradley";

export interface BinarizeOptions {
  method?: BinarizeMethod;
  /** 局所窓の一辺(px)。省略時は CONFIG から導出 */
  window?: number;
  k?: number;
}

export interface BinarizeResult extends Bilevel {
  /** 実際に使われた手法。フォールバックが起きたか判定できる */
  readonly methodUsed: BinarizeMethod;
  readonly window: number;
}

/** 長辺から局所窓サイズを導出する。常に奇数。 */
export function windowFor(width: number, height: number): number {
  const raw = Math.max(CONFIG.binarize.minWindow, Math.floor(Math.max(width, height) / CONFIG.binarize.windowDivisor));
  return raw | 1;
}

/**
 * 局所適応二値化。照明ムラ・影のある書類写真を前提にする。
 *
 * - sauvola : T = m * (1 + k * (s / R - 1))。二乗和の積分画像が要るため Float64 を確保する
 * - bradley : T = m * (1 - k)。合計のみで済み軽い
 *
 * 入力が CONFIG.limits.sauvolaMaxPixels を超える場合は bradley にフォールバックする。
 * 返り値の methodUsed でどちらが使われたか分かる(沈黙のフォールバックにしない)。
 */
export function binarize(src: Gray8, opts: BinarizeOptions = {}): BinarizeResult {
  const { width, height, data } = src;
  const n = width * height;
  const win = opts.window ?? windowFor(width, height);
  const r = win >> 1;

  let method: BinarizeMethod = opts.method ?? CONFIG.binarize.method;
  if (method === "sauvola" && n > CONFIG.limits.sauvolaMaxPixels) method = "bradley";

  const k = opts.k ?? (method === "sauvola" ? CONFIG.binarize.sauvolaK : CONFIG.binarize.bradleyK);
  const integral = buildIntegral(data, width, height, method === "sauvola");
  const iw = width + 1;
  const out = new Uint8Array(n);

  for (let y = 0; y < height; y++) {
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r >= height ? height - 1 : y + r;
    for (let x = 0; x < width; x++) {
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r >= width ? width - 1 : x + r;
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const mean = rectSum(integral.sum, iw, x0, y0, x1, y1) / area;

      let t: number;
      if (method === "sauvola") {
        const meanSq = rectSum(integral.sq!, iw, x0, y0, x1, y1) / area;
        const variance = meanSq - mean * mean;
        const std = variance > 0 ? Math.sqrt(variance) : 0;
        t = mean * (1 + k * (std / CONFIG.binarize.sauvolaR - 1));
      } else {
        t = mean * (1 - k);
      }
      out[y * width + x] = data[y * width + x] > t ? 1 : 0;
    }
  }

  return { width, height, data: out, methodUsed: method, window: win };
}
