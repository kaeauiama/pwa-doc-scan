import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EDGE_HANDLE_START,
  MIN_CROP_SIZE,
  edgeMidpoint,
  handlePosition,
  moveHandle,
} from "../core/crop.ts";
import { isAxisAligned } from "../core/warp.ts";
import type { Point, Quad } from "../core/types.ts";

const W = 1000;
const H = 800;

const rect: Quad = [
  { x: 100, y: 100 },
  { x: 900, y: 100 },
  { x: 900, y: 700 },
  { x: 100, y: 700 },
];

const skewed: Quad = [
  { x: 120, y: 90 },
  { x: 880, y: 130 },
  { x: 860, y: 700 },
  { x: 140, y: 660 },
];

const widthOf = (q: Quad) => q[1].x - q[0].x;
const heightOf = (q: Quad) => q[2].y - q[1].y;

test("handlePosition: 0〜3 は隅、4〜7 は辺の中点", () => {
  for (let i = 0; i < 4; i++) assert.deepEqual(handlePosition(rect, i), rect[i]);
  assert.deepEqual(handlePosition(rect, EDGE_HANDLE_START + 0), { x: 500, y: 100 }, "上辺");
  assert.deepEqual(handlePosition(rect, EDGE_HANDLE_START + 1), { x: 900, y: 400 }, "右辺");
  assert.deepEqual(handlePosition(rect, EDGE_HANDLE_START + 2), { x: 500, y: 700 }, "下辺");
  assert.deepEqual(handlePosition(rect, EDGE_HANDLE_START + 3), { x: 100, y: 400 }, "左辺");
  assert.deepEqual(edgeMidpoint(rect, 0), { x: 500, y: 100 });
});

/** ユーザー要望の核心: 左右のハンドルは幅だけ、上下のハンドルは高さだけを変える */
test("矩形モード: 右辺のハンドルは幅だけを変える", () => {
  const moved = moveHandle("rect", rect, EDGE_HANDLE_START + 1, { x: 700, y: 555 }, { x: -200, y: 155 }, W, H);
  assert.equal(widthOf(moved), 600, "幅が変わる");
  assert.equal(heightOf(moved), heightOf(rect), "高さは変わらない");
  assert.equal(moved[0].y, rect[0].y);
  assert.equal(moved[2].y, rect[2].y);
  assert.equal(isAxisAligned(moved), true);
});

test("矩形モード: 上辺のハンドルは高さだけを変える", () => {
  const moved = moveHandle("rect", rect, EDGE_HANDLE_START + 0, { x: 333, y: 250 }, { x: -167, y: 150 }, W, H);
  assert.equal(heightOf(moved), 450, "高さが変わる");
  assert.equal(widthOf(moved), widthOf(rect), "幅は変わらない");
  assert.equal(isAxisAligned(moved), true);
});

test("矩形モード: 左辺・下辺も同じ", () => {
  const left = moveHandle("rect", rect, EDGE_HANDLE_START + 3, { x: 300, y: 400 }, { x: 200, y: 0 }, W, H);
  assert.equal(widthOf(left), 600);
  assert.equal(heightOf(left), heightOf(rect));

  const bottom = moveHandle("rect", rect, EDGE_HANDLE_START + 2, { x: 500, y: 600 }, { x: 0, y: -100 }, W, H);
  assert.equal(heightOf(bottom), 500);
  assert.equal(widthOf(bottom), widthOf(rect));
});

test("矩形モード: 隅を動かしても軸並行のまま", () => {
  const moved = moveHandle("rect", rect, 0, { x: 250, y: 300 }, { x: 150, y: 200 }, W, H);
  assert.equal(isAxisAligned(moved), true);
  assert.deepEqual(moved[0], { x: 250, y: 300 });
  assert.equal(moved[1].y, 300, "右上も一緒に下がる");
  assert.equal(moved[3].x, 250, "左下も一緒に右へ寄る");
});

test("矩形モード: どのハンドルを動かしても軸並行を保つ", () => {
  for (let handle = 0; handle < 8; handle++) {
    for (const p of [{ x: 0, y: 0 }, { x: W, y: H }, { x: 480, y: 390 }] as Point[]) {
      const moved = moveHandle("rect", rect, handle, p, { x: 0, y: 0 }, W, H);
      assert.equal(isAxisAligned(moved), true, `handle=${handle} で軸並行が崩れた`);
      assert.ok(widthOf(moved) >= MIN_CROP_SIZE - 1e-9, `handle=${handle} で幅が潰れた`);
      assert.ok(heightOf(moved) >= MIN_CROP_SIZE - 1e-9, `handle=${handle} で高さが潰れた`);
    }
  }
});

test("矩形モード: 反対側を越えても反転せず最小サイズで止まる", () => {
  const moved = moveHandle("rect", rect, EDGE_HANDLE_START + 1, { x: 0, y: 400 }, { x: -900, y: 0 }, W, H);
  assert.equal(widthOf(moved), MIN_CROP_SIZE);
  assert.ok(moved[1].x > moved[0].x, "左右が入れ替わっていない");
});

test("矩形モード: 画像の外には出ない", () => {
  const moved = moveHandle("rect", rect, 2, { x: 5000, y: 5000 }, { x: 4100, y: 4300 }, W, H);
  for (const p of moved) {
    assert.ok(p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H);
  }
});

test("自由な四隅: 隅は単独で動く", () => {
  const moved = moveHandle("quad", skewed, 0, { x: 200, y: 200 }, { x: 80, y: 110 }, W, H);
  assert.deepEqual(moved[0], { x: 200, y: 200 });
  assert.deepEqual(moved[1], skewed[1], "他の隅は動かない");
  assert.deepEqual(moved[2], skewed[2]);
  assert.deepEqual(moved[3], skewed[3]);
});

test("自由な四隅: 辺のハンドルは両端をまとめて動かし、辺の向きと長さを保つ", () => {
  const before = skewed;
  const i = 1; // 右辺(隅 1 と隅 2)
  const moved = moveHandle("quad", before, EDGE_HANDLE_START + i, { x: 800, y: 400 }, { x: -60, y: 0 }, W, H);

  const lenBefore = Math.hypot(before[2].x - before[1].x, before[2].y - before[1].y);
  const lenAfter = Math.hypot(moved[2].x - moved[1].x, moved[2].y - moved[1].y);
  assert.ok(Math.abs(lenBefore - lenAfter) < 1e-6, "辺の長さが変わった");

  const dirBefore = Math.atan2(before[2].y - before[1].y, before[2].x - before[1].x);
  const dirAfter = Math.atan2(moved[2].y - moved[1].y, moved[2].x - moved[1].x);
  assert.ok(Math.abs(dirBefore - dirAfter) < 1e-6, "辺の向きが変わった");

  assert.deepEqual(moved[0], before[0], "反対側の隅は動かない");
  assert.deepEqual(moved[3], before[3]);
  assert.ok(moved[1].x < before[1].x, "内側に寄っている");
});

test("自由な四隅: 辺を動かしても画像の外に出ず、辺は傾かない", () => {
  const moved = moveHandle("quad", skewed, EDGE_HANDLE_START + 1, { x: 5000, y: 400 }, { x: 4000, y: 0 }, W, H);
  for (const p of moved) assert.ok(p.x >= -1e-6 && p.x <= W + 1e-6);
  const dirBefore = Math.atan2(skewed[2].y - skewed[1].y, skewed[2].x - skewed[1].x);
  const dirAfter = Math.atan2(moved[2].y - moved[1].y, moved[2].x - moved[1].x);
  assert.ok(Math.abs(dirBefore - dirAfter) < 1e-6, "端で止めたときに辺が傾いた");
});

test("範囲外のハンドル番号は何もしない", () => {
  assert.deepEqual([...moveHandle("rect", rect, -1, { x: 0, y: 0 }, { x: 0, y: 0 }, W, H)], [...rect]);
  assert.deepEqual([...moveHandle("quad", skewed, 99, { x: 0, y: 0 }, { x: 0, y: 0 }, W, H)], [...skewed]);
});
