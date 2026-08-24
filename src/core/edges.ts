import { buildIntegral, rectSum } from "./integral.ts";
import type { Gray8 } from "./types.ts";

/**
 * 照明の平坦化(フラットフィールド補正)。各画素を大きな窓の局所平均で割る。
 *
 * これが無いと、影で暗くなった側の紙の縁のコントラストが、
 * 明るい側の文字のコントラストを下回る。その状態で全画面一律の分位点しきい値を掛けると、
 * 暗い側の縁だけが落ちて輪郭検出が破綻する(実写で普通に起きる)。
 * 局所平均で正規化すると、コントラストが画面内のどこでも相対値になり、この逆転が消える。
 */
export function flattenIllumination(src: Gray8, windowDivisor = 4): Gray8 {
  const { width, height, data } = src;
  const win = Math.max(31, Math.floor(Math.max(width, height) / windowDivisor)) | 1;
  const r = win >> 1;
  const integral = buildIntegral(data, width, height, false);
  const iw = width + 1;
  const out = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r >= height ? height - 1 : y + r;
    for (let x = 0; x < width; x++) {
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r >= width ? width - 1 : x + r;
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const mean = rectSum(integral.sum, iw, x0, y0, x1, y1) / area;
      const v = mean < 1 ? 128 : (128 * data[y * width + x]) / mean;
      out[y * width + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return { width, height, data: out };
}

/** 分離型ガウシアン(5 タップ [1,4,6,4,1]/16)。 */
export function gaussianBlur(src: Gray8): Gray8 {
  const { width, height, data } = src;
  const tmp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);
  const clampX = (x: number) => (x < 0 ? 0 : x >= width ? width - 1 : x);
  const clampY = (y: number) => (y < 0 ? 0 : y >= height ? height - 1 : y);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      tmp[row + x] =
        (data[row + clampX(x - 2)] +
          4 * data[row + clampX(x - 1)] +
          6 * data[row + x] +
          4 * data[row + clampX(x + 1)] +
          data[row + clampX(x + 2)]) >>
        4;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] =
        (tmp[clampY(y - 2) * width + x] +
          4 * tmp[clampY(y - 1) * width + x] +
          6 * tmp[y * width + x] +
          4 * tmp[clampY(y + 1) * width + x] +
          tmp[clampY(y + 2) * width + x]) >>
        4;
    }
  }
  return { width, height, data: out };
}

export interface EdgeMap {
  readonly width: number;
  readonly height: number;
  /** 0 or 1 */
  readonly mask: Uint8Array;
  /** 0..255 に正規化した勾配強度 */
  readonly magnitude: Uint8Array;
  readonly threshold: number;
  readonly edgeCount: number;
}

/**
 * Sobel の勾配強度を求め、上位 keepRatio の画素だけをエッジとして残す。
 *
 * 固定しきい値ではなく分位点で切るのは、照明条件で勾配の絶対値が大きく変わるため。
 * 書類の縁は画面内で最も強い勾配のひとつになるので、比率で切れば条件に依らず残る。
 */
export function sobelEdges(src: Gray8, keepRatio = 0.12): EdgeMap {
  const { width, height, data } = src;
  const magnitude = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = data[i - width - 1];
      const t = data[i - width];
      const tr = data[i - width + 1];
      const l = data[i - 1];
      const r = data[i + 1];
      const bl = data[i + width - 1];
      const b = data[i + width];
      const br = data[i + width + 1];
      const gx = tr + 2 * r + br - (tl + 2 * l + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      // 最大 |g| は 1020。4 で割って 0..255 に収める
      const m = Math.min(255, (Math.abs(gx) + Math.abs(gy)) >> 2);
      magnitude[i] = m;
      histogram[m]++;
    }
  }

  const total = (width - 2) * (height - 2);
  const target = Math.max(1, Math.round(total * keepRatio));
  let acc = 0;
  let threshold = 255;
  for (let v = 255; v >= 0; v--) {
    acc += histogram[v];
    if (acc >= target) {
      threshold = v;
      break;
    }
  }
  if (threshold < 8) threshold = 8; // 真っ平らな画像で全画素がエッジになるのを防ぐ

  const mask = new Uint8Array(width * height);
  let edgeCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (magnitude[i] >= threshold) {
      mask[i] = 1;
      edgeCount++;
    }
  }
  return { width, height, mask, magnitude, threshold, edgeCount };
}
