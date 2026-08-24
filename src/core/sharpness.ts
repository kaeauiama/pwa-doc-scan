import { CONFIG } from "./config.ts";
import type { Gray8 } from "./types.ts";

export type SharpnessVerdict = "sharp" | "soft" | "blurry" | "unknown";

export interface SharpnessResult {
  readonly verdict: SharpnessVerdict;
  /** 大きいほど鮮明。ラプラシアンの標準偏差を、その領域の標準偏差で割った値 */
  readonly score: number;
  /** 各パッチのスコア。診断表示用 */
  readonly patchScores: readonly number[];
  /** 採用したパッチの標準偏差。低いと判定できない */
  readonly contrast: number;
  readonly patchSize: number;
}

export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SharpnessOptions {
  patchSize?: number;
  minContrast?: number;
  blurryBelow?: number;
  softBelow?: number;
}

/**
 * ラプラシアンの分散と、その領域自体の分散。
 *
 * ラプラシアンだけを見ると、文字の多い紙は高く、余白の多い紙は低く出る。
 * 領域の標準偏差で割ることで「どれだけ高周波が残っているか」の比になり、
 * 内容の濃さに引きずられにくくなる。
 */
function patchScore(
  data: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  size: number,
): { score: number; contrast: number } {
  let sum = 0;
  let sumSq = 0;
  let lapSum = 0;
  let lapSumSq = 0;
  let n = 0;

  for (let y = y0 + 1; y < y0 + size - 1; y++) {
    const row = y * width;
    for (let x = x0 + 1; x < x0 + size - 1; x++) {
      const c = data[row + x];
      const lap = 4 * c - data[row + x - 1] - data[row + x + 1] - data[row - width + x] - data[row + width + x];
      sum += c;
      sumSq += c * c;
      lapSum += lap;
      lapSumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return { score: 0, contrast: 0 };

  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const contrast = Math.sqrt(variance);

  const lapMean = lapSum / n;
  const lapVariance = Math.max(0, lapSumSq / n - lapMean * lapMean);
  const lapStd = Math.sqrt(lapVariance);

  return { score: contrast < 1 ? 0 : lapStd / contrast, contrast };
}

/**
 * ブレ・ピンぼけの度合いを測る(REQ-09)。
 *
 * 縮小するとブレが見えなくなるので、**必ず元の解像度のまま**測る。
 * 代わりに領域全体ではなく小さなパッチを 5 か所だけ見て負荷を抑える。
 *
 * 余白だけのパッチは高周波が無く、鮮明でも低いスコアになる。
 * そこで 5 か所のうち最も高いスコアを採用する。ブレは画面全体に一様にかかるので、
 * 「一番よく写っている場所」を見れば足りる。
 * どのパッチもコントラストが足りない場合は判定せず `unknown` を返す。
 */
export function measureSharpness(
  gray: Gray8,
  region?: Region,
  options: SharpnessOptions = {},
): SharpnessResult {
  const cfg = CONFIG.sharpness;
  const minContrast = options.minContrast ?? cfg.minContrast;
  const blurryBelow = options.blurryBelow ?? cfg.blurryBelow;
  const softBelow = options.softBelow ?? cfg.softBelow;

  const area: Region = region ?? { x: 0, y: 0, width: gray.width, height: gray.height };
  const left = Math.max(0, Math.round(area.x));
  const top = Math.max(0, Math.round(area.y));
  const right = Math.min(gray.width, Math.round(area.x + area.width));
  const bottom = Math.min(gray.height, Math.round(area.y + area.height));
  const regionWidth = right - left;
  const regionHeight = bottom - top;

  const patchSize = Math.min(options.patchSize ?? cfg.patchSize, regionWidth, regionHeight);
  if (patchSize < 16) {
    return { verdict: "unknown", score: 0, patchScores: [], contrast: 0, patchSize };
  }

  // 中央と四隅寄りの 5 か所
  const cx = left + (regionWidth - patchSize) / 2;
  const cy = top + (regionHeight - patchSize) / 2;
  const dx = (regionWidth - patchSize) / 4;
  const dy = (regionHeight - patchSize) / 4;
  const origins: [number, number][] = [
    [cx, cy],
    [cx - dx, cy - dy],
    [cx + dx, cy - dy],
    [cx - dx, cy + dy],
    [cx + dx, cy + dy],
  ];

  const scores: number[] = [];
  let best = -1;
  let bestContrast = 0;
  for (const [ox, oy] of origins) {
    const x0 = Math.max(left, Math.min(right - patchSize, Math.round(ox)));
    const y0 = Math.max(top, Math.min(bottom - patchSize, Math.round(oy)));
    const { score, contrast } = patchScore(gray.data, gray.width, x0, y0, patchSize);
    scores.push(score);
    if (contrast >= minContrast && score > best) {
      best = score;
      bestContrast = contrast;
    }
  }

  if (best < 0) {
    return { verdict: "unknown", score: 0, patchScores: scores, contrast: 0, patchSize };
  }

  const verdict: SharpnessVerdict = best < blurryBelow ? "blurry" : best < softBelow ? "soft" : "sharp";
  return { verdict, score: best, patchScores: scores, contrast: bestContrast, patchSize };
}
