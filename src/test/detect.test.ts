import { test } from "node:test";
import assert from "node:assert/strict";

import { detectDocumentQuad, orderQuad } from "../core/detect.ts";
import { rgbaToGray } from "../core/gray.ts";
import { warpGray } from "../core/warp.ts";
import { binarize } from "../core/binarize.ts";
import { agreement, makeDocumentPhoto } from "./fixtures/synthetic.ts";
import type { Point, Quad } from "../core/types.ts";

/** 四隅の最大ずれを、画像短辺に対する割合で返す(解像度に依らない指標にする) */
function cornerError(got: Quad, want: Quad, shortEdge: number): number {
  let worst = 0;
  for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot(got[i].x - want[i].x, got[i].y - want[i].y));
  return worst / shortEdge;
}

const PHOTO = { width: 1400, height: 1050 } as const;
const SHORT_EDGE = PHOTO.height;

function scene(opts: { pitch?: number; shading?: number; noise?: number; quad?: Quad; seed?: number }) {
  return makeDocumentPhoto(
    { width: 620, height: 877, seed: 42, strokePitch: opts.pitch ?? 5 },
    {
      ...PHOTO,
      shading: opts.shading ?? 0.5,
      noise: opts.noise ?? 8,
      seed: opts.seed ?? 21,
      quad: opts.quad,
    },
  );
}

test("orderQuad: どの順で渡しても TL,TR,BR,BL に揃う", () => {
  const canonical: Point[] = [
    { x: 10, y: 20 },
    { x: 200, y: 30 },
    { x: 190, y: 300 },
    { x: 20, y: 280 },
  ];
  for (let shift = 0; shift < 4; shift++) {
    const q = orderQuad([...canonical.slice(shift), ...canonical.slice(0, shift)]);
    assert.deepEqual([...q], canonical, `shift=${shift}`);
  }
  assert.deepEqual([...orderQuad([...canonical].reverse())], canonical, "逆回りで渡しても同じ");
});

test("素直な条件で四隅を検出できる", (t) => {
  const f = scene({ shading: 0.3, noise: 4 });
  const r = detectDocumentQuad(rgbaToGray(f.photo));
  assert.equal(r.ok, true, r.ok ? "" : `検出失敗: ${r.reason}`);
  if (!r.ok) return;

  const err = cornerError(r.quad, f.quad, SHORT_EDGE);
  t.diagnostic(
    `隅誤差 ${(err * 100).toFixed(2)}% / 被覆率 ${(r.confidence * 100).toFixed(0)}%` +
      ` / 面積比 ${(r.areaRatio * 100).toFixed(0)}% / 直線 ${r.diagnostics.lineCount} 本` +
      ` / 候補 ${r.diagnostics.quadsConsidered} 個`,
  );
  assert.ok(err < 0.005, `隅誤差 ${(err * 100).toFixed(2)}% が大きすぎます`);
});

test("影・ノイズ・傾きがあっても検出できる", (t) => {
  const cases = [
    { name: "影が強い", opts: { shading: 0.7, noise: 6 } },
    { name: "ノイズが多い", opts: { shading: 0.3, noise: 20 } },
    {
      name: "大きく傾いている",
      opts: {
        shading: 0.4,
        noise: 6,
        quad: [
          { x: 300, y: 60 },
          { x: 1220, y: 230 },
          { x: 1030, y: 960 },
          { x: 160, y: 730 },
        ] as unknown as Quad,
      },
    },
    { name: "見出しのような太い文字", opts: { pitch: 16 } },
  ];
  for (const c of cases) {
    const f = scene(c.opts);
    const r = detectDocumentQuad(rgbaToGray(f.photo));
    assert.equal(r.ok, true, `${c.name}: 検出失敗 ${r.ok ? "" : r.reason}`);
    if (!r.ok) continue;
    const err = cornerError(r.quad, f.quad, SHORT_EDGE);
    t.diagnostic(`${c.name}: 隅誤差 ${(err * 100).toFixed(2)}% / 被覆率 ${(r.confidence * 100).toFixed(0)}%`);
    assert.ok(err < 0.015, `${c.name}: 隅誤差 ${(err * 100).toFixed(2)}% が大きすぎます`);
  }
});

test("高解像度での辺の当て直しが隅の精度を一桁改善する", (t) => {
  const f = scene({});
  const gray = rgbaToGray(f.photo);
  const coarse = detectDocumentQuad(gray, { refine: false });
  const refined = detectDocumentQuad(gray, { refine: true });
  assert.equal(coarse.ok, true);
  assert.equal(refined.ok, true);
  if (!coarse.ok || !refined.ok) return;

  const eCoarse = cornerError(coarse.quad, f.quad, SHORT_EDGE);
  const eRefined = cornerError(refined.quad, f.quad, SHORT_EDGE);
  t.diagnostic(`粗検出 ${(eCoarse * 100).toFixed(2)}% -> 精密化 ${(eRefined * 100).toFixed(2)}%`);
  assert.ok(eRefined < eCoarse / 3, "精密化で誤差が 1/3 未満にならなければ効果が足りない");
  assert.ok(eRefined < 0.002, `精密化後の隅誤差 ${(eRefined * 100).toFixed(2)}% が大きすぎます`);
});

test("条件を振っても検出は破綻しない", (t) => {
  const quads: (Quad | undefined)[] = [
    undefined,
    [
      { x: 300, y: 60 },
      { x: 1220, y: 230 },
      { x: 1030, y: 960 },
      { x: 160, y: 730 },
    ] as unknown as Quad,
    [
      { x: 120, y: 80 },
      { x: 1290, y: 60 },
      { x: 1300, y: 990 },
      { x: 110, y: 970 },
    ] as unknown as Quad,
    [
      { x: 380, y: 230 },
      { x: 1030, y: 200 },
      { x: 1060, y: 850 },
      { x: 350, y: 830 },
    ] as unknown as Quad,
  ];

  const errors: number[] = [];
  let failures = 0;
  let lowConfidence = 0;
  for (const pitch of [4, 8, 16]) {
    for (const shading of [0.2, 0.7]) {
      for (const noise of [4, 18]) {
        for (const quad of quads) {
          const f = scene({ pitch, shading, noise, quad });
          const r = detectDocumentQuad(rgbaToGray(f.photo));
          if (!r.ok) {
            failures++;
            continue;
          }
          const err = cornerError(r.quad, f.quad, SHORT_EDGE);
          errors.push(err);
          // 外した時に確信度が高いままだと、UI が手動修正を促せない
          if (err > 0.015) {
            lowConfidence++;
            assert.ok(r.confidence < 0.75, `隅誤差 ${(err * 100).toFixed(1)}% なのに被覆率 ${r.confidence.toFixed(2)} は高すぎる`);
          }
        }
      }
    }
  }
  errors.sort((a, b) => a - b);
  const p95 = errors[Math.floor(errors.length * 0.95)];
  t.diagnostic(
    `${errors.length + failures} ケース: 失敗 ${failures} / 中央値 ${(errors[errors.length >> 1] * 100).toFixed(2)}%` +
      ` / p95 ${(p95 * 100).toFixed(2)}% / 最大 ${(errors[errors.length - 1] * 100).toFixed(2)}%` +
      ` / 誤検出 ${lowConfidence} 件(いずれも被覆率が低下)`,
  );
  assert.equal(failures, 0, "検出自体は全ケースで成立すること");
  assert.ok(p95 < 0.015, `p95 隅誤差 ${(p95 * 100).toFixed(2)}% が大きすぎます`);
});

test("検出 → 透視補正 → 二値化 を自動でつないでも紙面を復元できる", (t) => {
  const f = scene({});
  const gray = rgbaToGray(f.photo);
  const r = detectDocumentQuad(gray);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const auto = agreement(binarize(warpGray(gray, r.quad, f.page.width, f.page.height)), f.page, 8);
  const manual = agreement(binarize(warpGray(gray, f.quad, f.page.width, f.page.height)), f.page, 8);
  t.diagnostic(`自動四隅 ${(auto * 100).toFixed(2)}% / 正解四隅 ${(manual * 100).toFixed(2)}%`);
  assert.ok(auto > 0.95, `自動検出経由の一致率 ${(auto * 100).toFixed(2)}% が低すぎます`);
});

test("書類が写っていない画像は理由コードを返す(沈黙で失敗しない)", () => {
  const flat = { width: 300, height: 300, data: new Uint8Array(300 * 300).fill(180) };
  const r = detectDocumentQuad(flat);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(
    ["NO_EDGES", "NO_LINE_CANDIDATES", "NO_PERPENDICULAR_GROUPS", "NO_VALID_QUAD"].includes(r.reason),
    `想定外の理由: ${r.reason}`,
  );
  assert.ok(r.diagnostics.workingWidth > 0, "診断情報は失敗時にも返る");
});

test("書類が小さすぎる場合は採用しない", () => {
  const f = scene({
    shading: 0.2,
    noise: 4,
    quad: [
      { x: 600, y: 450 },
      { x: 780, y: 450 },
      { x: 780, y: 700 },
      { x: 600, y: 700 },
    ] as unknown as Quad,
  });
  const r = detectDocumentQuad(rgbaToGray(f.photo), { minAreaRatio: 0.15 });
  if (r.ok) assert.ok(r.areaRatio >= 0.15, "minAreaRatio を下回るものを採用してはいけない");
  else assert.equal(r.reason, "NO_VALID_QUAD");
});
