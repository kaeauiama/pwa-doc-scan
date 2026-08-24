import type { Gray8, Matrix3, Point, Quad, Rgba } from "./types.ts";

/** n x (n+1) の拡大係数行列を部分ピボット付き Gauss 消去で解く */
function solve(a: number[][], n: number): number[] {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error("computeHomography: 退化した四角形です");
    if (pivot !== col) [a[col], a[pivot]] = [a[pivot], a[col]];
    const p = a[col][col];
    for (let c = col; c <= n; c++) a[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row) => row[n]);
}

/**
 * from の 4 点を to の 4 点に写す射影変換を求める(DLT、h33 = 1 固定)。
 * 点の順序は from / to で対応していること(TL,TR,BR,BL)。
 */
export function computeHomography(from: Quad, to: Quad): Matrix3 {
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const h = solve(rows, 8);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyMatrix(m: Matrix3, p: Point): Point {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / w,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / w,
  };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 四隅から出力サイズを推定する。対辺の長い方を採用し、縦横比を保つ。
 * maxLongEdge を与えると長辺をそこに合わせて縮小する(出力 DPI の制御に使う)。
 */
export function estimateOutputSize(quad: Quad, maxLongEdge?: number): { width: number; height: number } {
  const [tl, tr, br, bl] = quad;
  let width = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  let height = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
  width = Math.max(1, width);
  height = Math.max(1, height);
  if (maxLongEdge && Math.max(width, height) > maxLongEdge) {
    const scale = maxLongEdge / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  return { width, height };
}

/**
 * 四隅を画像の内側に収める。
 *
 * 検出は画像の外側 20% まで角を許している(書類が画面からはみ出している構図に対応するため)。
 * だが画面の外の画素は存在せず、そのまま切り出しても白で埋まるだけで得るものがない。
 * さらに編集画面ではハンドルが画面外に出て掴めなくなる。
 * 編集に渡す前に必ずこれを通すこと。
 */
export function clampQuad(quad: Quad, width: number, height: number): Quad {
  const fix = (p: Point): Point => ({
    x: p.x < 0 ? 0 : p.x > width ? width : p.x,
    y: p.y < 0 ? 0 : p.y > height ? height : p.y,
  });
  return [fix(quad[0]), fix(quad[1]), fix(quad[2]), fix(quad[3])];
}

/**
 * 四隅を重心方向に fraction だけ縮める。
 *
 * 検出した四隅は紙の縁のわずかに外側に出ることがあり、そのまま切り出すと
 * 縁に机が写り込む。白飛ばしや二値化はその机を紙と誤認して汚れを作るので、
 * ほんの少し内側で切る。実際のスキャナアプリも同じことをしている。
 */
export function insetQuad(quad: Quad, fraction: number): Quad {
  if (fraction <= 0) return quad;
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const k = 1 - fraction;
  const moved = quad.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
  return [moved[0], moved[1], moved[2], moved[3]] as Quad;
}

/**
 * srcQuad が示す四角形を width x height の矩形に透視補正する。
 * 出力側から入力側への逆写像 + バイリニア補間。範囲外は白(255)で埋める。
 */
export function warpGray(src: Gray8, srcQuad: Quad, width: number, height: number): Gray8 {
  const dstQuad: Quad = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const inv = computeHomography(dstQuad, srcQuad);
  const out = new Uint8Array(width * height);
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;

  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const w = inv[6] * px + inv[7] * py + inv[8];
      const sx = (inv[0] * px + inv[1] * py + inv[2]) / w;
      const sy = (inv[3] * px + inv[4] * py + inv[5]) / w;

      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        out[y * width + x] = 255;
        continue;
      }
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 + 1 > sw - 1 ? sw - 1 : x0 + 1;
      const y1 = y0 + 1 > sh - 1 ? sh - 1 : y0 + 1;
      const fx = sx - x0;
      const fy = sy - y0;
      const top = sd[y0 * sw + x0] * (1 - fx) + sd[y0 * sw + x1] * fx;
      const bottom = sd[y1 * sw + x0] * (1 - fx) + sd[y1 * sw + x1] * fx;
      out[y * width + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return { width, height, data: out };
}

/**
 * `warpGray` のカラー版。カラー / グレースケール出力で使う(REQ-20)。
 * 補間とサンプリングの規則は `warpGray` と同一。範囲外は白で埋める。
 */
export function warpRgba(src: Rgba, srcQuad: Quad, width: number, height: number): Rgba {
  const dstQuad: Quad = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const inv = computeHomography(dstQuad, srcQuad);
  const out = new Uint8ClampedArray(width * height * 4);
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;

  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const w = inv[6] * px + inv[7] * py + inv[8];
      const sx = (inv[0] * px + inv[1] * py + inv[2]) / w;
      const sy = (inv[3] * px + inv[4] * py + inv[5]) / w;
      const o = (y * width + x) * 4;

      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        out[o] = 255;
        out[o + 1] = 255;
        out[o + 2] = 255;
        out[o + 3] = 255;
        continue;
      }
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 + 1 > sw - 1 ? sw - 1 : x0 + 1;
      const y1 = y0 + 1 > sh - 1 ? sh - 1 : y0 + 1;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - fx) + sd[i01 + c] * fx;
        const bottom = sd[i10 + c] * (1 - fx) + sd[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bottom * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
