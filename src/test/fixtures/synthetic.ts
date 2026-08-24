import { computeHomography } from "../../core/warp.ts";
import type { Bilevel, Point, Quad, Rgba } from "../../core/types.ts";

/** 再現性のための線形合同法。Math.random は使わない。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface PageOptions {
  width: number;
  height: number;
  /** 本文行の高さ(px) */
  lineHeight?: number;
  /** 文字ブロックの幅の下限・上限(px) */
  wordRange?: [number, number];
  /**
   * 縦ストロークの周期(px)。既定 5(= 3px 塗り + 2px 空き)。
   * 小さいほど細かい文字を模す。リサンプリングの限界を測るときに変える。
   */
  strokePitch?: number;
  seed?: number;
}

/** 理想的な紙面(正解データ)。1 = 白、0 = 黒。 */
export function makeIdealPage(opts: PageOptions): Bilevel {
  const { width, height } = opts;
  const lineHeight = opts.lineHeight ?? Math.round(height / 45);
  const [wMin, wMax] = opts.wordRange ?? [Math.round(width / 30), Math.round(width / 8)];
  const strokePitch = opts.strokePitch ?? 5;
  const strokeInk = Math.max(1, Math.round(strokePitch * 0.6));
  const rnd = lcg(opts.seed ?? 12345);
  const data = new Uint8Array(width * height).fill(1);

  const marginX = Math.round(width * 0.1);
  const marginY = Math.round(height * 0.08);
  const glyphH = Math.max(2, Math.round(lineHeight * 0.55));

  for (let y = marginY; y + lineHeight < height - marginY; y += lineHeight) {
    let x = marginX;
    const lineEnd = width - marginX;
    while (x < lineEnd) {
      const wordW = Math.round(wMin + rnd() * (wMax - wMin));
      const end = Math.min(x + wordW, lineEnd);
      for (let yy = y; yy < y + glyphH; yy++) {
        const row = yy * width;
        for (let xx = x; xx < end; xx++) {
          // 文字らしく縦ストロークを抜く
          if ((xx - x) % strokePitch < strokeInk) data[row + xx] = 0;
        }
      }
      x = end + Math.max(3, Math.round(glyphH * 0.6));
    }
  }
  return { width, height, data };
}

export interface PhotoOptions {
  /** 撮影画像のサイズ */
  width: number;
  height: number;
  /** 紙面が写る四隅(TL,TR,BR,BL)。省略時は軽い台形を自動生成 */
  quad?: Quad;
  /** 照明ムラの強さ 0..1。1 に近いほど暗い側が沈む */
  shading?: number;
  /** ガウシアン風ノイズの振幅(0..255) */
  noise?: number;
  /** 机の明るさ */
  background?: number;
  seed?: number;
}

export interface SyntheticPhoto {
  readonly photo: Rgba;
  readonly page: Bilevel;
  readonly quad: Quad;
}

/**
 * 「机の上の書類を斜めから撮った写真」を合成する。
 * 正解の紙面(page)と四隅(quad)が既知なので、透視補正と二値化の精度を数値で測れる。
 */
export function makeDocumentPhoto(pageOpts: PageOptions, photoOpts: PhotoOptions): SyntheticPhoto {
  const page = makeIdealPage(pageOpts);
  const { width, height } = photoOpts;
  const shading = photoOpts.shading ?? 0.55;
  const noise = photoOpts.noise ?? 6;
  const background = photoOpts.background ?? 120;
  const rnd = lcg(photoOpts.seed ?? 999);

  const quad: Quad =
    photoOpts.quad ??
    ([
      { x: width * 0.14, y: height * 0.09 },
      { x: width * 0.9, y: height * 0.15 },
      { x: width * 0.86, y: height * 0.93 },
      { x: width * 0.08, y: height * 0.86 },
    ] as const);

  const pageRect: Quad = [
    { x: 0, y: 0 },
    { x: page.width, y: 0 },
    { x: page.width, y: page.height },
    { x: 0, y: page.height },
  ];
  // 写真座標 → 紙面座標
  const toPage = computeHomography(quad, pageRect);

  const out = new Uint8ClampedArray(width * height * 4);
  const diag = Math.hypot(width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w = toPage[6] * px + toPage[7] * py + toPage[8];
      const sx = (toPage[0] * px + toPage[1] * py + toPage[2]) / w;
      const sy = (toPage[3] * px + toPage[4] * py + toPage[5]) / w;

      let v: number;
      if (sx < 0 || sy < 0 || sx >= page.width || sy >= page.height) {
        v = background;
      } else {
        v = page.data[(sy | 0) * page.width + (sx | 0)] ? 245 : 35;
      }

      // 左上が明るく右下が暗い照明ムラ(影を模す)
      const t = (x + y) / diag;
      v *= 1 - shading * t;
      v += (rnd() - 0.5) * 2 * noise;

      const i = (y * width + x) * 4;
      const c = v < 0 ? 0 : v > 255 ? 255 : v;
      out[i] = c;
      out[i + 1] = c;
      out[i + 2] = c;
      out[i + 3] = 255;
    }
  }

  return { photo: { width, height, data: out }, page, quad };
}

/** 二値画像同士の一致率(0..1)。境界の差を無視したい場合は margin を指定する。 */
export function agreement(a: Bilevel, b: Bilevel, margin = 0): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error("agreement: サイズ不一致");
  let same = 0;
  let total = 0;
  for (let y = margin; y < a.height - margin; y++) {
    for (let x = margin; x < a.width - margin; x++) {
      const i = y * a.width + x;
      if (a.data[i] === b.data[i]) same++;
      total++;
    }
  }
  return same / total;
}

/**
 * 正解側でエッジに接している画素を除いた一致率。
 *
 * リサンプリングを挟むと、ストロークの輪郭 1px は必ず中間値になり、
 * どんなアルゴリズムでも 0/1 のどちらに倒れるか決まらない。
 * 幾何が正しいか(ストロークが位置ごとずれていないか)を測りたいときは、
 * この曖昧な帯を除外しないと本質的でない差でしきい値が決まってしまう。
 */
export function agreementIgnoringEdges(a: Bilevel, truth: Bilevel, radius = 1, margin = 0): number {
  if (a.width !== truth.width || a.height !== truth.height) throw new Error("agreementIgnoringEdges: サイズ不一致");
  const { width, height, data } = truth;
  let same = 0;
  let total = 0;
  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      const i = y * width + x;
      let onEdge = false;
      for (let dy = -radius; dy <= radius && !onEdge; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (data[yy * width + xx] !== data[i]) {
            onEdge = true;
            break;
          }
        }
      }
      if (onEdge) continue;
      if (a.data[i] === data[i]) same++;
      total++;
    }
  }
  return total === 0 ? 1 : same / total;
}

export function pointsClose(a: Point, b: Point, tol: number): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}
