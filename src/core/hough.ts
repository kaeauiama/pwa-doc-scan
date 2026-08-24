import type { EdgeMap } from "./edges.ts";
import type { Point } from "./types.ts";

/** 直線 x cos(theta) + y sin(theta) = rho */
export interface Line {
  readonly rho: number;
  /** ラジアン。0..PI */
  readonly theta: number;
  readonly votes: number;
}

export interface HoughOptions {
  /** theta の刻み(度) */
  thetaStepDeg?: number;
  /** 取り出す直線の本数 */
  maxLines?: number;
  /** 非極大抑制の窓(rho 方向 px / theta 方向ビン) */
  nmsRho?: number;
  nmsTheta?: number;
}

/**
 * 標準 Hough 変換で直線候補を取り出す。
 *
 * 書類の縁は途切れることがある(影・低コントラスト)。輪郭追跡だと途切れで破綻するが、
 * Hough は投票なので部分的な欠落に強い。
 */
export function houghLines(edges: EdgeMap, opts: HoughOptions = {}): Line[] {
  const thetaStep = ((opts.thetaStepDeg ?? 1) * Math.PI) / 180;
  const nTheta = Math.round(Math.PI / thetaStep);
  const { width, height, mask } = edges;
  const diag = Math.ceil(Math.hypot(width, height));
  const nRho = diag * 2 + 1;

  const cos = new Float64Array(nTheta);
  const sin = new Float64Array(nTheta);
  for (let t = 0; t < nTheta; t++) {
    cos[t] = Math.cos(t * thetaStep);
    sin[t] = Math.sin(t * thetaStep);
  }

  const acc = new Int32Array(nTheta * nRho);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let t = 0; t < nTheta; t++) {
        const rho = Math.round(x * cos[t] + y * sin[t]) + diag;
        acc[t * nRho + rho]++;
      }
    }
  }

  const nmsRho = opts.nmsRho ?? 12;
  const nmsTheta = opts.nmsTheta ?? 3;
  const maxLines = opts.maxLines ?? 24;

  // 局所極大だけを候補にする
  const candidates: Line[] = [];
  for (let t = 0; t < nTheta; t++) {
    for (let r = 1; r < nRho - 1; r++) {
      const v = acc[t * nRho + r];
      if (v < 8) continue;
      let isMax = true;
      for (let dt = -nmsTheta; dt <= nmsTheta && isMax; dt++) {
        // theta は PI 周期。端は rho の符号が反転するので巻き込まない
        const tt = t + dt;
        if (tt < 0 || tt >= nTheta) continue;
        for (let dr = -nmsRho; dr <= nmsRho; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= nRho) continue;
          if (dt === 0 && dr === 0) continue;
          if (acc[tt * nRho + rr] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) candidates.push({ rho: r - diag, theta: t * thetaStep, votes: v });
    }
  }

  candidates.sort((a, b) => b.votes - a.votes);
  return candidates.slice(0, maxLines);
}

/** 2 直線の交点。平行に近い場合は null。 */
export function intersect(a: Line, b: Line): Point | null {
  const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.cos(b.theta) * Math.sin(a.theta);
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det,
    y: (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det,
  };
}

/** theta の差を 0..PI/2 に畳んだ角度差 */
export function angleDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/** 点から直線までの符号付き距離。中心が線のどちら側にあるかの判定に使う。 */
export function signedDistance(line: Line, p: Point): number {
  return p.x * Math.cos(line.theta) + p.y * Math.sin(line.theta) - line.rho;
}

/**
 * 直線が画像内を通る区間のうち、実際にエッジ画素が乗っている割合。
 * 「本当にそこに輪郭があるか」の裏づけになる(投票数だけだと偶然の直線が残る)。
 */
export function lineSupport(line: Line, edges: EdgeMap, tolerance = 2): number {
  const { width, height, mask } = edges;
  const cos = Math.cos(line.theta);
  const sin = Math.sin(line.theta);
  const steps = Math.ceil(Math.hypot(width, height));
  let inside = 0;
  let hit = 0;

  // 直線上を媒介変数で走査する
  const x0 = line.rho * cos;
  const y0 = line.rho * sin;
  for (let s = -steps; s <= steps; s++) {
    const x = Math.round(x0 - sin * s);
    const y = Math.round(y0 + cos * s);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    inside++;
    let found = false;
    for (let dy = -tolerance; dy <= tolerance && !found; dy++) {
      for (let dx = -tolerance; dx <= tolerance; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        if (mask[yy * width + xx]) {
          found = true;
          break;
        }
      }
    }
    if (found) hit++;
  }
  return inside === 0 ? 0 : hit / inside;
}
