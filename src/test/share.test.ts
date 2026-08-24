import { test } from "node:test";
import assert from "node:assert/strict";

import { ShareExporter } from "../adapters/WebExporters.ts";
import type { ExportPayload } from "../ports/Exporter.ts";

const payload: ExportPayload = {
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  filename: "scan-20260825-120000.pdf",
  mimeType: "application/pdf",
};

interface ShareCall {
  readonly data: ShareData;
  readonly keys: string[];
}

/**
 * `navigator` を差し替えて share の呼ばれ方を見る。
 * 実際の共有シートは実機でしか出せないが、**何を渡しているか**はここで固定できる。
 */
function withFakeNavigator<T>(
  behavior: { canShare?: boolean; shareError?: Error },
  run: (calls: ShareCall[]) => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: ShareCall[] = [];
  const fake = {
    canShare: () => behavior.canShare ?? true,
    share: async (data: ShareData) => {
      calls.push({ data, keys: Object.keys(data) });
      if (behavior.shareError) throw behavior.shareError;
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: fake, configurable: true, writable: true });
  return run(calls).finally(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
  });
}

/**
 * iOS は files と一緒に title / text / url を渡すと、それらを別の共有アイテムとして扱う。
 * 「ファイルに保存」を選ぶと PDF に加えてその文字列が .txt として書き出される(D-038)。
 * コードを読んでも気づけない類の不具合なので、渡している中身をテストで固定する。
 */
test("share には files しか渡さない(iOS で余計な .txt が生まれるのを防ぐ)", async () => {
  await withFakeNavigator({}, async (calls) => {
    const result = await new ShareExporter().export(payload);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].keys, ["files"], `share に余分なキーが渡っている: ${calls[0].keys.join(", ")}`);
    assert.equal(calls[0].data.title, undefined);
    assert.equal(calls[0].data.text, undefined);
    assert.equal(calls[0].data.url, undefined);
  });
});

test("share に渡すファイルは名前と MIME を保つ", async () => {
  await withFakeNavigator({}, async (calls) => {
    await new ShareExporter().export(payload);
    const files = calls[0].data.files;
    assert.ok(files && files.length === 1);
    assert.equal(files[0].name, payload.filename, "ファイル名は File 側が持つ");
    assert.equal(files[0].type, payload.mimeType);
    assert.equal(files[0].size, payload.bytes.length);
  });
});

test("共有シートを閉じただけならキャンセルとして扱う", async () => {
  const abort = new Error("cancelled");
  abort.name = "AbortError";
  await withFakeNavigator({ shareError: abort }, async () => {
    const result = await new ShareExporter().export(payload);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "CANCELLED_BY_USER");
  });
});

test("canShare が false なら理由コードを返して share を呼ばない", async () => {
  await withFakeNavigator({ canShare: false }, async (calls) => {
    const result = await new ShareExporter().export(payload);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "UNSUPPORTED_NO_SHARE_FILES");
    assert.equal(calls.length, 0);
  });
});
