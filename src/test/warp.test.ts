import { test } from "node:test";
import assert from "node:assert/strict";

import { applyMatrix, clampQuad, computeHomography, estimateOutputSize, insetQuad, warpGray } from "../core/warp.ts";
import { rgbaToGray } from "../core/gray.ts";
import { agreementIgnoringEdges, makeDocumentPhoto } from "./fixtures/synthetic.ts";
import type { Quad } from "../core/types.ts";

const quad: Quad = [
  { x: 30, y: 20 },
  { x: 270, y: 55 },
  { x: 250, y: 380 },
  { x: 15, y: 340 },
];
const rect: Quad = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 140 },
  { x: 0, y: 140 },
];

test("computeHomography: 4 点が指定どおり写る", () => {
  const h = computeHomography(quad, rect);
  for (let i = 0; i < 4; i++) {
    const got = applyMatrix(h, quad[i]);
    assert.ok(Math.abs(got.x - rect[i].x) < 1e-6, `x[${i}] = ${got.x}`);
    assert.ok(Math.abs(got.y - rect[i].y) < 1e-6, `y[${i}] = ${got.y}`);
  }
});

test("computeHomography: 逆変換と合成すると恒等に戻る", () => {
  const fwd = computeHomography(quad, rect);
  const inv = computeHomography(rect, quad);
  for (const p of [{ x: 120, y: 200 }, { x: 40, y: 60 }, { x: 240, y: 300 }]) {
    const back = applyMatrix(inv, applyMatrix(fwd, p));
    assert.ok(Math.abs(back.x - p.x) < 1e-6 && Math.abs(back.y - p.y) < 1e-6);
  }
});

test("computeHomography: 退化した四角形は明示的に失敗する", () => {
  const degenerate: Quad = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  assert.throws(() => computeHomography(degenerate, rect), /退化/);
});

test("estimateOutputSize: 対辺の長い方を採り、maxLongEdge で縮小する", () => {
  const full = estimateOutputSize(quad);
  assert.equal(full.width, Math.round(Math.max(Math.hypot(240, 35), Math.hypot(235, 40))));
  const capped = estimateOutputSize(quad, 100);
  assert.equal(Math.max(capped.width, capped.height), 100);
  const ratioFull = full.width / full.height;
  const ratioCapped = capped.width / capped.height;
  assert.ok(Math.abs(ratioFull - ratioCapped) < 0.02, "縦横比が保たれる");
});

test("warpGray: 台形に写った紙面を矩形に戻すと元の紙面と一致する", () => {
  // 文字ストロークは、写真→紙面のリサンプリング比に対して十分太くしておく。
  // ここで測りたいのは幾何の正しさであって、標本化限界以下の細部の復元力ではない。
  const { photo, page, quad: q } = makeDocumentPhoto(
    { width: 400, height: 560, seed: 11, strokePitch: 12 },
    { width: 800, height: 1000, shading: 0, noise: 0, seed: 5 },
  );
  const gray = rgbaToGray(photo);
  const warped = warpGray(gray, q, page.width, page.height);

  // 紙面の白黒(245 / 35)に対して中間値でしきい値を切る
  const bw = {
    width: page.width,
    height: page.height,
    data: Uint8Array.from(warped.data, (v) => (v > 140 ? 1 : 0)),
  };

  // ストロークの輪郭 1px は補間で必ず中間値になるため除外する。
  // 位置ずれが起きていればストローク内部で不一致が出るので、幾何の検証はこれで足りる。
  const acc = agreementIgnoringEdges(bw, page, 1, 4);
  assert.ok(acc > 0.999, `透視補正後の一致率(輪郭除く) ${(acc * 100).toFixed(3)}% が低すぎます`);
});

/**
 * L-1(PWA はフル解像度の静止画を撮れない)を数値で押さえるための回帰テスト。
 * 文字が細くなるほど復元率が落ちることを確認する。閾値ではなく単調性を検証する。
 */
test("細部の復元力は文字の太さに依存する(解像度不足の影響を可視化)", (t) => {
  const results: { pitch: number; acc: number }[] = [];
  for (const strokePitch of [16, 10, 6, 4, 3]) {
    const { photo, page, quad: q } = makeDocumentPhoto(
      { width: 400, height: 560, seed: 11, strokePitch },
      { width: 800, height: 1000, shading: 0, noise: 0, seed: 5 },
    );
    const warped = warpGray(rgbaToGray(photo), q, page.width, page.height);
    let same = 0;
    let total = 0;
    for (let y = 4; y < page.height - 4; y++) {
      for (let x = 4; x < page.width - 4; x++) {
        const i = y * page.width + x;
        if ((warped.data[i] > 140 ? 1 : 0) === page.data[i]) same++;
        total++;
      }
    }
    results.push({ pitch: strokePitch, acc: same / total });
  }
  for (const r of results) t.diagnostic(`strokePitch=${r.pitch}px -> 一致率 ${(r.acc * 100).toFixed(2)}%`);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i].acc < results[i - 1].acc, `pitch ${results[i].pitch}px で一致率が下がるはず`);
  }
});

test("insetQuad: 重心方向に一様に縮み、比率と重心を保つ", () => {
  const q: Quad = [
    { x: 100, y: 200 },
    { x: 400, y: 220 },
    { x: 380, y: 700 },
    { x: 90, y: 660 },
  ];
  const inset = insetQuad(q, 0.1);
  const centroid = (v: Quad) => ({
    x: (v[0].x + v[1].x + v[2].x + v[3].x) / 4,
    y: (v[0].y + v[1].y + v[2].y + v[3].y) / 4,
  });
  const c0 = centroid(q);
  const c1 = centroid(inset);
  assert.ok(Math.abs(c0.x - c1.x) < 1e-9 && Math.abs(c0.y - c1.y) < 1e-9, "重心が動かない");

  for (let i = 0; i < 4; i++) {
    const d0 = Math.hypot(q[i].x - c0.x, q[i].y - c0.y);
    const d1 = Math.hypot(inset[i].x - c1.x, inset[i].y - c1.y);
    assert.ok(Math.abs(d1 / d0 - 0.9) < 1e-9, `隅 ${i} の縮小率`);
  }
  assert.deepEqual([...insetQuad(q, 0)], [...q], "0 なら何もしない");
});

test("clampQuad: 画像の外に出た角を内側に収める", () => {
  const outside: Quad = [
    { x: -40, y: -25 },
    { x: 1180, y: 10 },
    { x: 1050, y: 900 },
    { x: 30, y: 870 },
  ];
  const clamped = clampQuad(outside, 1000, 800);
  assert.deepEqual(clamped[0], { x: 0, y: 0 }, "左上が画像内に入る");
  assert.deepEqual(clamped[1], { x: 1000, y: 10 }, "右にはみ出した x だけ詰まる");
  assert.deepEqual(clamped[2], { x: 1000, y: 800 });
  assert.deepEqual(clamped[3], { x: 30, y: 800 });
  for (const p of clamped) {
    assert.ok(p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 800, "全ての角が画像内");
  }
});

test("clampQuad: 既に画像内なら何も変えない", () => {
  const inside: Quad = [
    { x: 10, y: 20 },
    { x: 900, y: 30 },
    { x: 890, y: 700 },
    { x: 20, y: 690 },
  ];
  assert.deepEqual([...clampQuad(inside, 1000, 800)], [...inside]);
});
