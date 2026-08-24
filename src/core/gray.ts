import type { Gray8, Rgba } from "./types.ts";

/** ITU-R BT.601 相当の輝度。整数演算で丸める。 */
export function rgbaToGray(src: Rgba): Gray8 {
  const n = src.width * src.height;
  const out = new Uint8Array(n);
  const d = src.data;
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    out[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  }
  return { width: src.width, height: src.height, data: out };
}
