import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULTS, fullFrameQuad, outputSizeFor, scanToPage } from "../pipeline.ts";
import { whitenBackground } from "../core/whiten.ts";
import { makeDocumentPhoto, makeIdealPage } from "./fixtures/synthetic.ts";
import type { JpegEncoder } from "../ports/JpegEncoder.ts";
import type { Rgba } from "../core/types.ts";
import type { RenderMode } from "../pipeline.ts";

/** JPEG エンコーダは canvas 依存なので、Node では受け取った画像を記録する偽物を使う */
class FakeJpegEncoder implements JpegEncoder {
  readonly calls: { width: number; height: number; quality: number; image: Rgba }[] = [];
  readonly #bytes: Uint8Array;

  constructor() {
    this.#bytes = new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", "tiny.jpg")));
  }

  async encode(image: Rgba, quality: number): Promise<Uint8Array> {
    this.calls.push({ width: image.width, height: image.height, quality, image });
    return this.#bytes;
  }
}

const fixture = makeDocumentPhoto(
  { width: 620, height: 877, seed: 42 },
  { width: 1400, height: 1050, shading: 0.5, noise: 8, seed: 21 },
);

test("白黒2値モードは JPEG エンコーダを呼ばず 1bit ページを作る", async () => {
  const jpeg = new FakeJpegEncoder();
  const r = await scanToPage(fixture.photo, { mode: "bilevel", dpi: 200 }, jpeg);
  assert.equal(jpeg.calls.length, 0, "白黒2値で JPEG は使わない");
  assert.equal(r.page.image.kind, "bilevel");
  assert.equal(r.processed.kind, "bilevel");
  assert.equal(r.mode, "bilevel");
  assert.ok(r.detection?.ok, "四隅を渡さなければ自動検出する");
});

test("カラー / グレースケールは JPEG ページを作り、出力サイズが一致する", async () => {
  for (const mode of ["color", "grayscale"] as RenderMode[]) {
    const jpeg = new FakeJpegEncoder();
    const r = await scanToPage(fixture.photo, { mode, dpi: 200 }, jpeg);
    assert.equal(jpeg.calls.length, 1, `${mode}: JPEG を 1 回だけエンコードする`);
    assert.equal(r.page.image.kind, "jpeg");
    assert.equal(r.processed.kind, "rgba");
    assert.equal(jpeg.calls[0].width, r.outputWidth);
    assert.equal(jpeg.calls[0].height, r.outputHeight);
    assert.equal(jpeg.calls[0].quality, DEFAULTS.jpegQuality);
  }
});

test("グレースケールモードの出力は彩度を持たない", async () => {
  const jpeg = new FakeJpegEncoder();
  await scanToPage(fixture.photo, { mode: "grayscale", dpi: 150 }, jpeg);
  const { data } = jpeg.calls[0].image;
  let colored = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2]) colored++;
  }
  assert.equal(colored, 0, "R=G=B でない画素があってはいけない");
});

test("カラーモードは色を保つ", async () => {
  // 青みがかった紙面を作り、出力に色が残ることを見る
  const tinted: Rgba = {
    width: fixture.photo.width,
    height: fixture.photo.height,
    data: Uint8ClampedArray.from(fixture.photo.data, (v, i) => (i % 4 === 2 ? Math.min(255, v * 1.3) : v)),
  };
  const jpeg = new FakeJpegEncoder();
  await scanToPage(tinted, { mode: "color", dpi: 150 }, jpeg);
  const { data } = jpeg.calls[0].image;
  let colored = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - data[i + 2]) > 6) colored++;
  }
  assert.ok(colored > data.length / 4 / 20, "カラーモードで色が失われている");
});

test("四隅を渡したときは自動検出しない", async () => {
  const jpeg = new FakeJpegEncoder();
  const quad = fullFrameQuad(fixture.photo.width, fixture.photo.height);
  const r = await scanToPage(fixture.photo, { mode: "bilevel", quad, inset: 0 }, jpeg);
  assert.equal(r.detection, null);
  assert.deepEqual([...r.quad], [...quad]);
});

test("既定では四隅を内側へ詰めてから切り出す(縁に机が入るのを防ぐ)", async () => {
  const jpeg = new FakeJpegEncoder();
  const quad = fullFrameQuad(1000, 800);
  const withInset = await scanToPage(fixture.photo, { mode: "bilevel", quad }, jpeg);
  const noInset = await scanToPage(fixture.photo, { mode: "bilevel", quad, inset: 0 }, jpeg);
  assert.ok(withInset.quad[0].x > noInset.quad[0].x, "左上が内側に寄る");
  assert.ok(withInset.quad[0].y > noInset.quad[0].y);
  assert.ok(withInset.quad[2].x < noInset.quad[2].x, "右下が内側に寄る");
  assert.ok(withInset.outputWidth < noInset.outputWidth);
});

test("出力サイズは原稿の比率を保ち、A4 相当を上限にする", () => {
  const dpi = 200;
  const a4Long = Math.round((297 / 25.4) * dpi);

  // 横長のレシート状。A4 の長辺より小さいので、そのままの大きさで出る
  const receipt = outputSizeFor(fullFrameQuad(2000, 400), dpi);
  assert.ok(Math.abs(receipt.width / receipt.height - 5) < 0.05, "比率が保たれる");
  assert.equal(receipt.width, 2000, "上限を超えないものは縮めない");

  // 12.2MP のフレーム全体。長辺が A4 を超えるので縮む
  const full = outputSizeFor(fullFrameQuad(4032, 3024), dpi);
  assert.equal(Math.max(full.width, full.height), a4Long, "長辺が A4 の長辺に収まる");
  assert.ok(Math.abs(full.width / full.height - 4032 / 3024) < 0.01, "縮めても比率は保つ");
});

test("背景の白飛ばしは紙を白に寄せ、インクは暗いまま残す", (t) => {
  // 机を含む写真では「暗い画素 = インク」にならないので、
  // 紙だけの画像を作り、正解マスク(page.data)で紙とインクを分けて測る
  const page = makeIdealPage({ width: 620, height: 877, seed: 5 });
  const data = new Uint8ClampedArray(page.width * page.height * 4);
  const diag = Math.hypot(page.width, page.height);
  for (let y = 0; y < page.height; y++) {
    for (let x = 0; x < page.width; x++) {
      const i = y * page.width + x;
      // 左上が明るく右下が暗い照明ムラ。紙 245 / インク 35
      const shade = 1 - 0.5 * ((x + y) / diag);
      const v = (page.data[i] ? 245 : 35) * shade;
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
  }
  const before: Rgba = { width: page.width, height: page.height, data };
  const after = whitenBackground(before);

  let paperBefore = 0, paperAfter = 0, paperN = 0;
  let inkBefore = 0, inkAfter = 0, inkN = 0;
  for (let i = 0; i < page.data.length; i++) {
    const b = data[i * 4];
    const a = after.data[i * 4];
    if (page.data[i]) { paperBefore += b; paperAfter += a; paperN++; }
    else { inkBefore += b; inkAfter += a; inkN++; }
  }
  const pB = paperBefore / paperN, pA = paperAfter / paperN;
  const iB = inkBefore / inkN, iA = inkAfter / inkN;
  t.diagnostic(`紙 ${pB.toFixed(0)} -> ${pA.toFixed(0)} / インク ${iB.toFixed(0)} -> ${iA.toFixed(0)}`);

  assert.ok(pA > 240, `紙が白に寄っていない (${pA.toFixed(0)})`);
  assert.ok(iA <= iB, `インクが明るくなっている (${iB.toFixed(0)} -> ${iA.toFixed(0)})`);
  assert.ok(pA - iA > pB - iB, "紙とインクの差が広がっていない");
});

test("白飛ばしは照明ムラを消す(紙の明るさが場所によらなくなる)", () => {
  const page = makeIdealPage({ width: 400, height: 560, seed: 9 });
  const data = new Uint8ClampedArray(page.width * page.height * 4);
  const diag = Math.hypot(page.width, page.height);
  for (let y = 0; y < page.height; y++) {
    for (let x = 0; x < page.width; x++) {
      const i = y * page.width + x;
      const v = (page.data[i] ? 245 : 35) * (1 - 0.6 * ((x + y) / diag));
      data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
    }
  }
  const after = whitenBackground({ width: page.width, height: page.height, data });

  /** 指定領域の紙画素の平均 */
  const paperMean = (x0: number, y0: number, x1: number, y1: number, src: ArrayLike<number>) => {
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * page.width + x;
        if (page.data[i]) { sum += src[i * 4]; n++; }
      }
    }
    return sum / n;
  };
  const w = page.width, h = page.height;
  const beforeSpread = Math.abs(paperMean(0, 0, w >> 1, h >> 1, data) - paperMean(w >> 1, h >> 1, w, h, data));
  const afterSpread = Math.abs(paperMean(0, 0, w >> 1, h >> 1, after.data) - paperMean(w >> 1, h >> 1, w, h, after.data));
  assert.ok(beforeSpread > 40, "元画像に十分な照明ムラがある前提");
  assert.ok(afterSpread < beforeSpread / 8, `ムラが残っている (${beforeSpread.toFixed(0)} -> ${afterSpread.toFixed(0)})`);
});
