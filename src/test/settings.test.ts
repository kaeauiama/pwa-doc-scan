import { test } from "node:test";
import assert from "node:assert/strict";

import { strengthToK } from "../pipeline.ts";
import { binarize } from "../core/binarize.ts";
import { CONFIG } from "../core/config.ts";
import { rgbaToGray } from "../core/gray.ts";
import { warpGray } from "../core/warp.ts";
import { makeDocumentPhoto } from "./fixtures/synthetic.ts";

test("strengthToK: 段階が k に対応し、範囲外は丸める", () => {
  const steps = CONFIG.binarize.strengthSteps.sauvola;
  assert.equal(strengthToK("sauvola", 0), steps[0]);
  assert.equal(strengthToK("sauvola", steps.length - 1), steps[steps.length - 1]);
  assert.equal(strengthToK("sauvola", -5), steps[0], "下限に丸める");
  assert.equal(strengthToK("sauvola", 99), steps[steps.length - 1], "上限に丸める");
  assert.equal(strengthToK("sauvola", undefined), undefined, "未指定なら既定に任せる");
  assert.notEqual(strengthToK("bradley", 0), strengthToK("sauvola", 0), "方式ごとに別の値");
});

test("strengthToK: 段階は薄い順に並んでいる(k が下がるほど濃くなる)", () => {
  for (const method of ["sauvola", "bradley"] as const) {
    const steps = CONFIG.binarize.strengthSteps[method];
    for (let i = 1; i < steps.length; i++) {
      assert.ok(steps[i] < steps[i - 1], `${method} の段階 ${i} が薄い順になっていない`);
    }
  }
});

test("文字の濃さを上げると黒い画素が増える", (t) => {
  const f = makeDocumentPhoto(
    { width: 620, height: 877, seed: 42, strokePitch: 6 },
    { width: 2000, height: 1500, shading: 0.5, noise: 10, seed: 21 },
  );
  const warped = warpGray(rgbaToGray(f.photo), f.quad, f.page.width, f.page.height);

  for (const method of ["sauvola", "bradley"] as const) {
    const inkAt = (strength: number) => {
      const bw = binarize(warped, { method, k: strengthToK(method, strength) });
      let ink = 0;
      for (const v of bw.data) if (!v) ink++;
      return ink / bw.data.length;
    };
    const light = inkAt(0);
    const dark = inkAt(4);
    t.diagnostic(`${method}: 最も薄い ${(light * 100).toFixed(1)}% -> 最も濃い ${(dark * 100).toFixed(1)}%`);
    assert.ok(dark > light, `${method} で濃さを上げても黒が増えていない`);
  }
});
