import { downscaleGray } from "./resize.ts";
import { flattenIllumination, gaussianBlur, sobelEdges } from "./edges.ts";
import { intersect } from "./hough.ts";
import type { Line } from "./hough.ts";
import type { Gray8, Point, Quad } from "./types.ts";

export interface RefineOptions {
  /** 精密化に使う画像の長辺(px)。粗検出より高い解像度を使う */
  longEdge?: number;
  /** 各辺の法線方向に探索する幅(精密化画像の px) */
  band?: number;
  /** 辺に沿ってサンプルする点の間隔(px) */
  step?: number;
}

const DEFAULTS = { longEdge: 960, band: 10, step: 1 } as const;

function normalize(p: Point): Point {
  const n = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / n, y: p.y / n };
}

/** 総最小二乗(主成分)で点群に直線を当てる。外れ値を 1 回だけ落として再フィットする。 */
function fitLine(points: readonly Point[]): Line | null {
  if (points.length < 8) return null;

  function fit(pts: readonly Point[]): { line: Line; normal: Point; centroid: Point } | null {
    const n = pts.length;
    if (n < 8) return null;
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= n;
    cy /= n;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const p of pts) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    if (sxx + syy < 1e-9) return null;
    // 主軸(点群が伸びる方向)の角度
    const major = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const normal = normalize({ x: -Math.sin(major), y: Math.cos(major) });
    let theta = Math.atan2(normal.y, normal.x);
    let rho = cx * normal.x + cy * normal.y;
    if (theta < 0) {
      theta += Math.PI;
      rho = -rho;
    }
    return { line: { rho, theta, votes: n }, normal, centroid: { x: cx, y: cy } };
  }

  const first = fit(points);
  if (!first) return null;

  // 残差の MAD で外れ値を落とす(文字や机の模様を拾った点を除く)
  const residuals = points.map((p) =>
    Math.abs((p.x - first.centroid.x) * first.normal.x + (p.y - first.centroid.y) * first.normal.y),
  );
  const sorted = [...residuals].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const deviations = residuals.map((r) => Math.abs(r - median)).sort((a, b) => a - b);
  const mad = deviations[deviations.length >> 1];
  const cutoff = Math.max(1.5, median + 2.5 * 1.4826 * mad);
  const kept = points.filter((_, i) => residuals[i] <= cutoff);

  return (fit(kept) ?? first).line;
}

/**
 * 粗検出した四隅を、より高い解像度で精密化する。
 *
 * 粗検出は縮小画像で行う(本文の行に惑わされないため)が、その分だけ隅の精度が落ちる。
 * ここでは各辺の近傍だけを高解像度で見て、勾配の尾根に直線を当て直す。
 * 探索範囲を辺の近傍に限るので、縮小せずに済み、かつ文字に引っ張られない。
 */
export function refineQuad(src: Gray8, coarse: Quad, options: RefineOptions = {}): Quad {
  const opt = { ...DEFAULTS, ...options };
  const { image: work, scale } = downscaleGray(src, opt.longEdge);
  const edges = sobelEdges(gaussianBlur(flattenIllumination(work)), 0.15);
  const mag = edges.magnitude;
  const { width, height } = work;

  const q = coarse.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const lines: (Line | null)[] = [];

  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 8) {
      lines.push(null);
      continue;
    }
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const nor = { x: -dir.y, y: dir.x };
    const points: Point[] = [];

    // 隅の近くは隣の辺の勾配が混ざるので、両端 8% は使わない
    for (let t = len * 0.08; t <= len * 0.92; t += opt.step) {
      const px = a.x + dir.x * t;
      const py = a.y + dir.y * t;
      let bestMag = 0;
      let bestS = 0;
      for (let s = -opt.band; s <= opt.band; s += 0.5) {
        const x = Math.round(px + nor.x * s);
        const y = Math.round(py + nor.y * s);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const m = mag[y * width + x];
        if (m > bestMag) {
          bestMag = m;
          bestS = s;
        }
      }
      if (bestMag >= edges.threshold) {
        points.push({ x: px + nor.x * bestS, y: py + nor.y * bestS });
      }
    }
    lines.push(fitLine(points));
  }

  // 1 辺でも当てられなければ、粗検出の結果をそのまま返す(悪化させない)
  if (lines.some((l) => l === null)) return coarse;

  const inv = 1 / scale;
  const corners: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const prev = lines[(i + 3) % 4]!;
    const cur = lines[i]!;
    const p = intersect(prev, cur);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return coarse;
    corners.push({ x: p.x * inv, y: p.y * inv });
  }

  // 精密化で大きく動いたら、当てる辺を間違えた可能性が高いので採用しない
  const shortEdge = Math.min(src.width, src.height);
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(corners[i].x - coarse[i].x, corners[i].y - coarse[i].y) > shortEdge * 0.05) {
      return coarse;
    }
  }
  return [corners[0], corners[1], corners[2], corners[3]] as Quad;
}
