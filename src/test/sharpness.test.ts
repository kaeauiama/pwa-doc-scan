import { test } from "node:test";
import assert from "node:assert/strict";

import { measureSharpness } from "../core/sharpness.ts";
import { gaussianBlur } from "../core/edges.ts";
import { rgbaToGray } from "../core/gray.ts";
import { makeDocumentPhoto, makeIdealPage } from "./fixtures/synthetic.ts";
import type { Gray8 } from "../core/types.ts";

/** 紙面をそのまま等倍のグレー画像にする(切り出し後の相当物) */
function pageAsGray(strokePitch: number, width = 1654, height = 2339): Gray8 {
  const page = makeIdealPage({ width, height, seed: 7, strokePitch });
  const data = new Uint8Array(width * height);
  for (let i = 0; i < page.data.length; i++) data[i] = page.data[i] ? 240 : 40;
  return { width, height, data };
}

function blurred(src: Gray8, times: number): Gray8 {
  let out = src;
  for (let i = 0; i < times; i++) out = gaussianBlur(out);
  return out;
}

test("ぼかすほどスコアが下がる(単調性)", (t) => {
  for (const pitch of [6, 12, 24]) {
    const base = pageAsGray(pitch);
    const scores = [0, 1, 2, 3].map((n) => measureSharpness(blurred(base, n)).score);
    t.diagnostic(`pitch=${pitch}px: ${scores.map((s) => s.toFixed(3)).join(" -> ")}`);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] < scores[i - 1], `pitch=${pitch} の ${i} 回目でスコアが下がらなかった`);
    }
  }
});

test("鮮明な紙面は sharp、ぼかしたものは sharp にしない", (t) => {
  // 閾値は誤警告を避けて低めに置いてある(U-13)。
  // そのため「1〜2 回のぼかし」は blurry ではなく soft に落ちることがある。
  // ここで固定したいのは「鮮明なものを sharp と言い、ぼけたものを sharp と言わない」こと。
  for (const pitch of [6, 12, 24, 48]) {
    const base = pageAsGray(pitch);
    assert.equal(measureSharpness(base).verdict, "sharp", `pitch=${pitch} の鮮明な紙面`);

    const twice = measureSharpness(blurred(base, 2));
    assert.notEqual(twice.verdict, "sharp", `pitch=${pitch} の 2 回ぼかしを鮮明と言っている`);

    const thrice = measureSharpness(blurred(base, 3));
    assert.equal(thrice.verdict, "blurry", `pitch=${pitch} の 3 回ぼかし (score=${thrice.score.toFixed(3)})`);
    t.diagnostic(`pitch=${pitch}: 鮮明 sharp / 2回 ${twice.verdict} / 3回 ${thrice.verdict}`);
  }
});

test("余白だけの画像は判定せず unknown を返す(沈黙で断定しない)", () => {
  const blank: Gray8 = { width: 1200, height: 1600, data: new Uint8Array(1200 * 1600).fill(238) };
  const r = measureSharpness(blank);
  assert.equal(r.verdict, "unknown");
  assert.equal(r.contrast, 0);
});

test("小さすぎる領域は判定しない", () => {
  const g = pageAsGray(6, 300, 300);
  const r = measureSharpness(g, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(r.verdict, "unknown");
});

test("余白が多くても、文字のある場所を見つけて判定できる", () => {
  // 上 4/5 が余白、下 1/5 だけに文字がある紙面
  const width = 1200;
  const height = 1600;
  const page = makeIdealPage({ width, height: Math.round(height / 5), seed: 3, strokePitch: 6 });
  const data = new Uint8Array(width * height).fill(240);
  for (let y = 0; y < page.height; y++) {
    for (let x = 0; x < Math.min(width, page.width); x++) {
      data[(y + height - page.height) * width + x] = page.data[y * page.width + x] ? 240 : 40;
    }
  }
  const gray: Gray8 = { width, height, data };
  const r = measureSharpness(gray);
  assert.notEqual(r.verdict, "unknown", "文字のあるパッチを拾えていない");
  assert.ok(r.patchScores.some((s) => s === 0), "余白のパッチは 0 になる");
});

test("撮影画像(机・影・ノイズ込み)でも鮮明とブレを区別できる", (t) => {
  for (const noise of [4, 16]) {
    const f = makeDocumentPhoto(
      { width: 620, height: 877, seed: 42, strokePitch: 6 },
      { width: 2400, height: 1800, shading: 0.5, noise, seed: 21 },
    );
    const gray = rgbaToGray(f.photo);
    const sharp = measureSharpness(gray);
    const soft = measureSharpness(blurred(gray, 2));
    t.diagnostic(`noise=${noise}: 鮮明 ${sharp.score.toFixed(3)} (${sharp.verdict}) / ぼかし ${soft.score.toFixed(3)} (${soft.verdict})`);
    assert.equal(sharp.verdict, "sharp");
    assert.equal(soft.verdict, "blurry");
  }
});

test("領域を指定するとその中だけを見る", () => {
  const g = pageAsGray(6, 1600, 1600);
  const whole = measureSharpness(g);
  // 文字が無い上端の帯だけを指定すると判定できないはず
  const band = measureSharpness(g, { x: 0, y: 0, width: 1600, height: 100 });
  assert.equal(whole.verdict, "sharp");
  assert.equal(band.verdict, "unknown");
});
