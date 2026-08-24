import type { Bilevel } from "./types.ts";

/**
 * 1bit を MSB 先頭で行ごとにパックする。1 = 白。
 * PNG も PDF もこの並びを要求する。違いは PNG が各行頭にフィルタバイトを持つことだけ。
 */
export function packBits(img: Bilevel, filterByte: boolean): Uint8Array {
  const { width, height, data } = img;
  const rowBytes = (width + 7) >> 3;
  const stride = rowBytes + (filterByte ? 1 : 0);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const base = y * stride + (filterByte ? 1 : 0);
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x]) out[base + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

export function rowBytesOf(width: number): number {
  return (width + 7) >> 3;
}
