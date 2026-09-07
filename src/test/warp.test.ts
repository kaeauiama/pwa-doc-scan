import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyMatrix,
  boundingQuad,
  clampQuad,
  computeHomography,
  estimateOutputSize,
  insetQuad,
  isAxisAligned,
  warpGray,
} from "../core/warp.ts";
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
 *
 * 撮影画像が紙面より粗い場合、細い文字は原理的に戻らない。
 * ここでは写真を紙面より小さく撮り、文字が細いほど復元率が落ちることを見る。
 *
 * 注: 写真が紙面より大きい(=十分な解像度がある)場合は、
 * 標本化の基準さえ揃っていれば完全に復元できる。以前この条件で 92〜97% しか
 * 出ていなかったのは warpGray の半画素ずれ(D-042)が原因だった。
 */
test("撮影解像度が足りないと細い文字ほど復元できない", (t) => {
  const results: { pitch: number; acc: number }[] = [];
  for (const strokePitch of [16, 10, 6, 4, 3]) {
    const { photo, page, quad: q } = makeDocumentPhoto(
      { width: 800, height: 1120, seed: 11, strokePitch },
      // 紙面より粗い写真。実機で遠くから撮った状況に相当する
      { width: 420, height: 560, shading: 0, noise: 0, seed: 5 },
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
  assert.ok(
    results[0].acc > results[results.length - 1].acc,
    "太い文字の方が復元率が高いはず",
  );
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

test("boundingQuad: 四隅を囲む最小の軸並行矩形になる", () => {
  const skewed: Quad = [
    { x: 30, y: 20 },
    { x: 270, y: 55 },
    { x: 250, y: 380 },
    { x: 15, y: 340 },
  ];
  const box = boundingQuad(skewed);
  assert.deepEqual([...box], [
    { x: 15, y: 20 },
    { x: 270, y: 20 },
    { x: 270, y: 380 },
    { x: 15, y: 380 },
  ]);
  assert.equal(isAxisAligned(box), true);
  assert.equal(isAxisAligned(skewed), false);
  assert.deepEqual([...boundingQuad(box)], [...box], "既に矩形なら変わらない");
});

test("軸並行の矩形で切り抜くと、拡大縮小だけで歪みが出ない", () => {
  // 縦横の直線が入った画像。歪めば線が曲がるので判定できる
  const w = 400;
  const h = 300;
  const data = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x % 20 === 0 || y % 20 === 0) data[y * w + x] = 0;
    }
  }
  const src = { width: w, height: h, data };

  const box: Quad = [
    { x: 40, y: 30 },
    { x: 340, y: 30 },
    { x: 340, y: 230 },
    { x: 40, y: 230 },
  ];
  // 等倍で切り出せば、元画像の該当領域とそのまま一致するはず
  const out = warpGray(src, box, 300, 200);
  let mismatch = 0;
  for (let y = 1; y < 199; y++) {
    for (let x = 1; x < 299; x++) {
      if (out.data[y * 300 + x] !== data[(y + 30) * w + (x + 40)]) mismatch++;
    }
  }
  assert.equal(mismatch, 0, `軸並行の切り抜きで ${mismatch} 画素ずれた`);
});

test("台形で切り抜くと上下で拡大率が変わる(矩形モードが必要な理由)", (t) => {
  // 等間隔の縦線。線は 3px 幅。1px だと縮小で線が消え、
  // 「歪み」ではなく「取りこぼし」を測ってしまう
  const w = 400;
  const h = 300;
  const data = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (x % 20 < 3) data[y * w + x] = 0;
  }
  const src = { width: w, height: h, data };

  /** 指定した行で、黒帯が始まる x の平均間隔 */
  const gapAt = (img: { width: number; height: number; data: Uint8Array }, ratio: number) => {
    const y = Math.round((img.height - 1) * ratio);
    const xs: number[] = [];
    for (let x = 1; x < img.width - 1; x++) {
      if (img.data[y * img.width + x] < 128 && img.data[y * img.width + x - 1] >= 128) xs.push(x);
    }
    if (xs.length < 3) return NaN;
    return (xs[xs.length - 1] - xs[0]) / (xs.length - 1);
  };

  // 上辺が狭く下辺が広い台形。四隅を独立に動かすと簡単にこうなる
  const skewed: Quad = [
    { x: 80, y: 30 },
    { x: 320, y: 30 },
    { x: 360, y: 230 },
    { x: 40, y: 230 },
  ];
  const box = boundingQuad(skewed);
  const outW = Math.round(box[1].x - box[0].x);
  const outH = Math.round(box[2].y - box[1].y);

  const skewedImg = warpGray(src, skewed, outW, outH);
  const boxImg = warpGray(src, box, outW, outH);

  const skewedTop = gapAt(skewedImg, 0.1);
  const skewedBottom = gapAt(skewedImg, 0.9);
  const boxTop = gapAt(boxImg, 0.1);
  const boxBottom = gapAt(boxImg, 0.9);

  t.diagnostic(
    `台形: 上 ${skewedTop.toFixed(2)}px / 下 ${skewedBottom.toFixed(2)}px, ` +
      `矩形: 上 ${boxTop.toFixed(2)}px / 下 ${boxBottom.toFixed(2)}px`,
  );
  // 台形では上下で拡大率が変わる = 同じ大きさの文字が上下で違う大きさになる
  assert.ok(Math.abs(skewedTop - skewedBottom) > 2, "台形なのに上下の拡大率が同じ(前提が崩れている)");
  // 矩形なら上下で完全に同じ
  assert.ok(Math.abs(boxTop - boxBottom) < 0.01, `矩形なのに上下で拡大率が違う (${boxTop} vs ${boxBottom})`);
});
