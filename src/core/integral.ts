/**
 * 積分画像(Summed-area table)。(w+1) x (h+1) で、境界を 0 で持つ。
 * 局所平均・局所分散を O(1) で引くために使う。
 */

export interface Integral {
  readonly width: number;
  readonly height: number;
  readonly sum: Uint32Array;
  /** 二乗和。要求されたときだけ確保する(Float64 は重い) */
  readonly sq?: Float64Array;
}

export function buildIntegral(data: Uint8Array, width: number, height: number, withSquares: boolean): Integral {
  const iw = width + 1;
  const sum = new Uint32Array(iw * (height + 1));
  const sq = withSquares ? new Float64Array(iw * (height + 1)) : undefined;
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSq = 0;
    const dst = (y + 1) * iw;
    const up = y * iw;
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      rowSum += v;
      sum[dst + x + 1] = sum[up + x + 1] + rowSum;
      if (sq) {
        rowSq += v * v;
        sq[dst + x + 1] = sq[up + x + 1] + rowSq;
      }
    }
  }
  return { width, height, sum, sq };
}

/** 閉区間 [x0,x1] x [y0,y1] の合計。境界は呼び出し側でクランプ済みであること。 */
export function rectSum(t: Uint32Array | Float64Array, iw: number, x0: number, y0: number, x1: number, y1: number): number {
  return t[(y1 + 1) * iw + (x1 + 1)] - t[y0 * iw + (x1 + 1)] - t[(y1 + 1) * iw + x0] + t[y0 * iw + x0];
}
