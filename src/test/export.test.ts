import { test } from "node:test";
import assert from "node:assert/strict";

import { exportWithFallback } from "../adapters/WebExporters.ts";
import { MemoryExporter } from "../adapters/MemoryExporter.ts";
import type { ExportPayload, ExportResult, Exporter } from "../ports/Exporter.ts";

const payload: ExportPayload = {
  bytes: new Uint8Array([1, 2, 3]),
  filename: "scan.pdf",
  mimeType: "application/pdf",
};

function fake(id: string, available: boolean, result: ExportResult): Exporter & { calls: number } {
  return {
    id,
    calls: 0,
    isAvailable: () => available,
    async export() {
      (this as { calls: number }).calls++;
      return result;
    },
  };
}

test("使えない書き出し先は飛ばして次を試す", async () => {
  const unavailable = fake("a", false, { ok: true });
  const memory = new MemoryExporter();
  const r = await exportWithFallback(payload, [unavailable, memory]);
  assert.equal(r.ok, true);
  assert.equal(r.exporterId, "memory");
  assert.equal(unavailable.calls, 0, "使えない先は呼ばない");
  assert.equal(memory.written.length, 1);
});

test("失敗したら次の書き出し先に落ちる", async () => {
  const failing = fake("share", true, { ok: false, reason: "UNSUPPORTED_NO_SHARE_FILES" });
  const memory = new MemoryExporter();
  const r = await exportWithFallback(payload, [failing, memory]);
  assert.equal(r.ok, true);
  assert.equal(r.exporterId, "memory");
  assert.equal(failing.calls, 1);
});

test("利用者が自分で閉じた場合は次を試さない", async () => {
  const cancelled = fake("share", true, { ok: false, reason: "CANCELLED_BY_USER" });
  const memory = new MemoryExporter();
  const r = await exportWithFallback(payload, [cancelled, memory]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "CANCELLED_BY_USER");
  assert.equal(memory.written.length, 0, "キャンセルを別経路で上書きしない");
});

test("全部だめなら最後の理由コードを返す(沈黙で失敗しない)", async () => {
  const a = fake("a", true, { ok: false, reason: "UNSUPPORTED_NO_SHARE_FILES" });
  const b = fake("b", true, { ok: false, reason: "UNSUPPORTED_NO_DOWNLOAD" });
  const r = await exportWithFallback(payload, [a, b]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "UNSUPPORTED_NO_DOWNLOAD");
});

test("書き出し先が空でも例外を投げず理由コードを返す", async () => {
  const r = await exportWithFallback(payload, []);
  assert.equal(r.ok, false);
});
