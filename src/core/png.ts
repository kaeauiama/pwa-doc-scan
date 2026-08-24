import { crc32 } from "./crc32.ts";
import { concatBytes, deflateZlib } from "./deflate.ts";
import { packBits } from "./pack.ts";
import type { Bilevel } from "./types.ts";

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const ASCII = new TextEncoder();

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(ASCII.encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** pHYs チャンク。ピクセル/メートルで DPI を埋める */
function phys(dpi: number): Uint8Array {
  const d = new Uint8Array(9);
  const dv = new DataView(d.buffer);
  const ppm = Math.round(dpi / 0.0254);
  dv.setUint32(0, ppm);
  dv.setUint32(4, ppm);
  d[8] = 1; // 単位 = メートル
  return chunk("pHYs", d);
}

/** bitDepth=1 / colorType=0(グレースケール)の PNG を生成する。 */
export async function encodePng1bit(img: Bilevel, dpi?: number): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, img.width);
  dv.setUint32(4, img.height);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = await deflateZlib(packBits(img, true));
  const parts = [SIGNATURE, chunk("IHDR", ihdr)];
  if (dpi) parts.push(phys(dpi));
  parts.push(chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)));
  return concatBytes(parts);
}
