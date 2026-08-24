import type { ExportPayload, ExportResult, Exporter } from "../ports/Exporter.ts";

function toFile(payload: ExportPayload): File {
  // 元のバッファを共有しないよう、必ずコピーを取ってから File にする
  const copy = new Uint8Array(payload.bytes);
  return new File([copy], payload.filename, { type: payload.mimeType });
}

/**
 * 共有シートへ書き出す。iOS での主動線(D-005)。
 * 実機(iOS 18.7 / Safari 26.6)で PDF の書き出しに成功することを確認済み。
 *
 * **`share()` には files 以外を渡さないこと(D-038)。**
 * iOS は files と一緒に title / text / url を渡すと、それらを別の共有アイテムとして扱う。
 * 「ファイルに保存」を選ぶと、PDF に加えてその文字列が .txt として書き出されてしまう。
 * ファイル名は File 側が持っているので、title は不要。
 */
export class ShareExporter implements Exporter {
  readonly id = "share";

  isAvailable(payload: ExportPayload): boolean {
    if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    try {
      return navigator.canShare({ files: [toFile(payload)] });
    } catch {
      return false;
    }
  }

  async export(payload: ExportPayload): Promise<ExportResult> {
    if (!this.isAvailable(payload)) {
      return { ok: false, reason: "UNSUPPORTED_NO_SHARE_FILES" };
    }
    try {
      await navigator.share({ files: [toFile(payload)] });
      return { ok: true };
    } catch (err) {
      // 共有シートを閉じただけの場合も AbortError で来る。失敗として扱わない
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, reason: "CANCELLED_BY_USER" };
      }
      return {
        ok: false,
        reason: "FAILED_UNKNOWN",
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
  }
}

/**
 * `<a download>` で保存する副動線。
 * iOS の standalone では動作が不安定との報告が続いているため、既定にはしない。
 */
export class DownloadExporter implements Exporter {
  readonly id = "download";

  isAvailable(): boolean {
    return typeof URL.createObjectURL === "function" && "download" in document.createElement("a");
  }

  async export(payload: ExportPayload): Promise<ExportResult> {
    if (!this.isAvailable()) return { ok: false, reason: "UNSUPPORTED_NO_DOWNLOAD" };
    try {
      const url = URL.createObjectURL(toFile(payload));
      const a = document.createElement("a");
      a.href = url;
      a.download = payload.filename;
      a.rel = "noopener";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      // クリックが実際に保存に至ったかはブラウザ側からは分からない
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: "FAILED_UNKNOWN",
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
  }
}

/**
 * 使える書き出し先を順に試す。
 * 全部だめなら理由コードを返す(REQ-14: 沈黙で失敗しない)。
 */
export async function exportWithFallback(
  payload: ExportPayload,
  exporters: readonly Exporter[],
): Promise<ExportResult & { exporterId?: string }> {
  let last: ExportResult = { ok: false, reason: "UNSUPPORTED_NO_SHARE_FILES" };
  for (const exporter of exporters) {
    if (!exporter.isAvailable(payload)) continue;
    const result = await exporter.export(payload);
    if (result.ok) return { ...result, exporterId: exporter.id };
    // 利用者が自分で閉じた場合は次を試さない
    if (result.reason === "CANCELLED_BY_USER") return { ...result, exporterId: exporter.id };
    last = result;
  }
  return last;
}
