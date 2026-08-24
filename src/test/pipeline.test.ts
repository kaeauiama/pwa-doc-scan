import { test } from "node:test";
import assert from "node:assert/strict";

import { FixtureImageSource } from "../adapters/FixtureImageSource.ts";
import { MemoryExporter } from "../adapters/MemoryExporter.ts";
import { rgbaToGray } from "../core/gray.ts";
import { warpGray } from "../core/warp.ts";
import { binarize } from "../core/binarize.ts";
import { encodePdf1bit } from "../core/pdf.ts";
import { CONFIG } from "../core/config.ts";
import { agreement, makeDocumentPhoto } from "./fixtures/synthetic.ts";
import type { ImageSource } from "../ports/ImageSource.ts";
import type { Exporter } from "../ports/Exporter.ts";
import type { Quad } from "../core/types.ts";

/**
 * 撮影から書き出しまでの実処理。ImageSource / Exporter を受け取るので、
 * 実機でも合成画像でも同じコードが動く。M1 ではこれをアプリ本体が呼ぶ。
 */
async function scanToPdf(source: ImageSource, exporter: Exporter, quad: Quad, method: "sauvola" | "bradley") {
  await source.start();
  const frame = await source.capture();
  source.stop();

  const gray = rgbaToGray(frame);
  const warped = warpGray(gray, quad, 620, 877);
  const bw = binarize(warped, { method });
  const bytes = await encodePdf1bit([{ image: bw, dpi: CONFIG.output.defaultDpi }]);
  const result = await exporter.export({ bytes, filename: "scan.pdf", mimeType: "application/pdf" });
  return { bw, bytes, result };
}

// 影が強く、ノイズもある「実際にありがちな」撮影条件
const fixture = makeDocumentPhoto(
  { width: 620, height: 877, seed: 42 },
  { width: 1600, height: 1200, shading: 0.55, noise: 8, seed: 77 },
);

test("影とノイズがあっても、透視補正 + 適応二値化で紙面を復元できる", async (t) => {
  const exporter = new MemoryExporter();
  const source = new FixtureImageSource(fixture.photo, "shaded-a4");
  const { bw, bytes, result } = await scanToPdf(source, exporter, fixture.quad, "sauvola");

  assert.equal(bw.methodUsed, "sauvola");
  assert.equal(result.ok, true);
  assert.equal(exporter.written.length, 1);
  assert.equal(exporter.written[0].filename, "scan.pdf");

  const acc = agreement(bw, fixture.page, 6);
  t.diagnostic(`一致率 ${(acc * 100).toFixed(2)}% / PDF ${(bytes.length / 1024).toFixed(1)}KB` +
    ` / ${bw.width}x${bw.height} @ ${CONFIG.output.defaultDpi}dpi / 窓 ${bw.window}px`);
  assert.ok(acc > 0.93, `一致率 ${(acc * 100).toFixed(2)}% が低すぎます`);
  assert.ok(bytes.length < 100 * 1024, `PDF が ${(bytes.length / 1024).toFixed(1)}KB で NFR-03 を超えています`);
});

test("大域しきい値では影に負けることを確認する(適応二値化が必要な根拠)", () => {
  const gray = rgbaToGray(fixture.photo);
  const warped = warpGray(gray, fixture.quad, 620, 877);

  // Otsu ではなく単純な固定しきい値。影のある写真では必ず崩れる
  const global = {
    width: warped.width,
    height: warped.height,
    data: Uint8Array.from(warped.data, (v) => (v > 128 ? 1 : 0)),
  };
  const globalAcc = agreement(global, fixture.page, 6);
  const localAcc = agreement(binarize(warped, { method: "sauvola" }), fixture.page, 6);

  assert.ok(localAcc > globalAcc + 0.05, `適応 ${(localAcc * 100).toFixed(1)}% / 大域 ${(globalAcc * 100).toFixed(1)}%`);
});

test("sauvola と bradley はどちらも動き、どちらを使ったか申告する", () => {
  const gray = rgbaToGray(fixture.photo);
  const warped = warpGray(gray, fixture.quad, 620, 877);
  for (const method of ["sauvola", "bradley"] as const) {
    const r = binarize(warped, { method });
    assert.equal(r.methodUsed, method);
    assert.ok(r.window % 2 === 1, "窓サイズは奇数");
    assert.ok(agreement(r, fixture.page, 6) > 0.9, `${method} の一致率が低すぎます`);
  }
});

test("画素数が上限を超えると sauvola は bradley に落ちる(沈黙のフォールバックにしない)", () => {
  const big = CONFIG.limits.sauvolaMaxPixels;
  const w = 4000;
  const h = Math.ceil(big / w) + 10;
  const gray = { width: w, height: h, data: new Uint8Array(w * h).fill(200) };
  const r = binarize(gray, { method: "sauvola", window: 15 });
  assert.equal(r.methodUsed, "bradley");
});
