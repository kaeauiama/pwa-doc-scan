import type { Gray8 } from "./types.ts";

/**
 * ボックスフィルタによる縮小。輪郭検出は縮小画像で行うため、
 * エイリアスを出さない平均化が要る(単純な間引きだと細線が消えたり偽の線が出る)。
 */
export function downscaleGray(src: Gray8, longEdge: number): { image: Gray8; scale: number } {
  const srcLong = Math.max(src.width, src.height);
  if (srcLong <= longEdge) return { image: src, scale: 1 };

  const scale = longEdge / srcLong;
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8Array(width * height);

  const xRatio = src.width / width;
  const yRatio = src.height / height;

  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(src.height, Math.max(sy0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(src.width, Math.max(sx0 + 1, Math.floor((x + 1) * xRatio)));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * src.width;
        for (let sx = sx0; sx < sx1; sx++) {
          sum += src.data[row + sx];
          n++;
        }
      }
      out[y * width + x] = (sum / n) | 0;
    }
  }
  // 実際の縮小率は丸めで少しずれるので、戻す時に使う値をそのまま返す
  return { image: { width, height, data: out }, scale: width / src.width };
}
