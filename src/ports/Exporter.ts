/** 書き出しの失敗理由。沈黙の失敗にしないため、UI にこのコードを出す(REQ-14)。 */
export type ExportFailureReason =
  | "UNSUPPORTED_NO_SHARE_FILES"
  | "UNSUPPORTED_NO_DOWNLOAD"
  | "CANCELLED_BY_USER"
  | "FAILED_UNKNOWN";

export type ExportResult = { ok: true } | { ok: false; reason: ExportFailureReason; detail?: string };

export interface ExportPayload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
}

/**
 * 生成物の書き出し先。ここもデバイス境界。
 *   - ShareExporter    navigator.share({ files })  … iOS の主動線(D-005)
 *   - DownloadExporter <a download>                … 副動線
 *   - MemoryExporter   テスト用(バイト列を保持するだけ)
 */
export interface Exporter {
  readonly id: string;
  isAvailable(payload: ExportPayload): boolean;
  export(payload: ExportPayload): Promise<ExportResult>;
}
