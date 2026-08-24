import type { ExportPayload, ExportResult, Exporter } from "../ports/Exporter.ts";

/** テスト用の Exporter。書き出したバイト列を保持するだけ。 */
export class MemoryExporter implements Exporter {
  readonly id = "memory";
  readonly written: ExportPayload[] = [];

  isAvailable(): boolean {
    return true;
  }

  async export(payload: ExportPayload): Promise<ExportResult> {
    this.written.push(payload);
    return { ok: true };
  }
}
