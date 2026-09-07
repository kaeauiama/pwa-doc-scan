import type { Point, Quad } from "./types.ts";

/**
 * 切り抜きの方法。
 *
 * - `quad` : 四隅を自由に動かす。斜めから撮った書類のゆがみを直せる
 * - `rect` : 軸並行の矩形に固定する。**射影変換が単なる拡大縮小になり、原理的に歪まない**
 *
 * 四隅を独立に動かすと、わずかなずれでも台形になる。台形は上下(または左右)で
 * 拡大率が変わるため、同じ大きさの文字が場所によって違う大きさに写る。
 * 「多少雑でもいいから歪ませたくない」ときのために `rect` がある。
 */
export type CropMode = "quad" | "rect";

/** 0〜3 が四隅、4〜7 が辺(辺 i は隅 i と隅 i+1 を結ぶ) */
export const EDGE_HANDLE_START = 4;
export const HANDLE_COUNT = 8;

/** 潰れて操作不能にならないための最小の幅・高さ(画像座標) */
export const MIN_CROP_SIZE = 24;

export function isEdgeHandle(handle: number): boolean {
  return handle >= EDGE_HANDLE_START;
}

/** 辺の中点。ハンドルを置く位置 */
export function edgeMidpoint(quad: Quad, edge: number): Point {
  const a = quad[edge % 4];
  const b = quad[(edge + 1) % 4];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** ハンドル番号に対応する画面上の位置 */
export function handlePosition(quad: Quad, handle: number): Point {
  return isEdgeHandle(handle) ? edgeMidpoint(quad, handle - EDGE_HANDLE_START) : quad[handle];
}

function clampPoint(p: Point, width: number, height: number): Point {
  return {
    x: p.x < 0 ? 0 : p.x > width ? width : p.x,
    y: p.y < 0 ? 0 : p.y > height ? height : p.y,
  };
}

/** p0 から v 方向へ動かすとき、[0,width]x[0,height] に留まる最大の倍率(0〜1) */
function maxTravel(p0: Point, v: Point, width: number, height: number): number {
  let t = 1;
  if (v.x > 1e-9) t = Math.min(t, (width - p0.x) / v.x);
  else if (v.x < -1e-9) t = Math.min(t, -p0.x / v.x);
  if (v.y > 1e-9) t = Math.min(t, (height - p0.y) / v.y);
  else if (v.y < -1e-9) t = Math.min(t, -p0.y / v.y);
  return Math.max(0, Math.min(1, t));
}

/** 自由な四隅。隅は単独で、辺は両端をまとめて法線方向に動かす */
function moveOnQuad(base: Quad, handle: number, pointer: Point, delta: Point, width: number, height: number): Quad {
  const next = [...base] as Point[];

  if (!isEdgeHandle(handle)) {
    next[handle] = clampPoint(pointer, width, height);
    return next as unknown as Quad;
  }

  const edge = handle - EDGE_HANDLE_START;
  const i = edge;
  const j = (edge + 1) % 4;
  const a = base[i];
  const b = base[j];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return base;

  // 辺に沿う成分は辺自体を動かさず、隣の辺だけを意図せず伸ばす。法線成分だけ使う
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const nx = -uy;
  const ny = ux;
  const amount = delta.x * nx + delta.y * ny;
  const v: Point = { x: nx * amount, y: ny * amount };

  // 両端とも画像内に留まる範囲までしか動かさない。片方だけ止めると辺が傾く
  const t = Math.min(maxTravel(a, v, width, height), maxTravel(b, v, width, height));
  next[i] = { x: a.x + v.x * t, y: a.y + v.y * t };
  next[j] = { x: b.x + v.x * t, y: b.y + v.y * t };
  return next as unknown as Quad;
}

/** 軸並行の矩形。隅は 2 辺を、辺のハンドルは 1 辺だけを動かす */
function moveOnRect(base: Quad, handle: number, pointer: Point, width: number, height: number): Quad {
  let x0 = Math.min(base[0].x, base[3].x);
  let x1 = Math.max(base[1].x, base[2].x);
  let y0 = Math.min(base[0].y, base[1].y);
  let y1 = Math.max(base[2].y, base[3].y);

  const px = Math.max(0, Math.min(width, pointer.x));
  const py = Math.max(0, Math.min(height, pointer.y));

  const setLeft = (v: number) => (x0 = Math.min(v, x1 - MIN_CROP_SIZE));
  const setRight = (v: number) => (x1 = Math.max(v, x0 + MIN_CROP_SIZE));
  const setTop = (v: number) => (y0 = Math.min(v, y1 - MIN_CROP_SIZE));
  const setBottom = (v: number) => (y1 = Math.max(v, y0 + MIN_CROP_SIZE));

  switch (handle) {
    case 0: setLeft(px); setTop(py); break;
    case 1: setRight(px); setTop(py); break;
    case 2: setRight(px); setBottom(py); break;
    case 3: setLeft(px); setBottom(py); break;
    case EDGE_HANDLE_START + 0: setTop(py); break;    // 上辺 = 高さだけ
    case EDGE_HANDLE_START + 1: setRight(px); break;  // 右辺 = 幅だけ
    case EDGE_HANDLE_START + 2: setBottom(py); break; // 下辺 = 高さだけ
    case EDGE_HANDLE_START + 3: setLeft(px); break;   // 左辺 = 幅だけ
    default: break;
  }

  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/**
 * ハンドルを動かした結果の四隅を返す。
 *
 * `base` はドラッグ開始時の四隅、`pointer` はいまの指の位置(画像座標)、
 * `delta` は開始位置からの移動量。辺の移動量を出すのに `delta` が要る。
 */
export function moveHandle(
  mode: CropMode,
  base: Quad,
  handle: number,
  pointer: Point,
  delta: Point,
  width: number,
  height: number,
): Quad {
  if (handle < 0 || handle >= HANDLE_COUNT) return base;
  return mode === "rect"
    ? moveOnRect(base, handle, pointer, width, height)
    : moveOnQuad(base, handle, pointer, delta, width, height);
}
