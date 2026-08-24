import type { Rgba } from "../core/types.ts";

export type SourceKind = "live-camera" | "file-import" | "fixture";

/** 画像を取り込めなかった理由。UI にそのまま出す(REQ-14: 沈黙の失敗にしない)。 */
export type SourceFailureReason =
  | "UNSUPPORTED_NO_GETUSERMEDIA"
  | "UNSUPPORTED_INSECURE_CONTEXT"
  | "PERMISSION_DENIED"
  | "NO_CAMERA"
  | "CAMERA_BUSY"
  | "UNSUPPORTED_CONSTRAINTS"
  | "NOT_STARTED"
  | "DECODE_FAILED"
  | "FAILED_UNKNOWN";

export class SourceError extends Error {
  readonly reason: SourceFailureReason;

  constructor(reason: SourceFailureReason, message?: string) {
    super(message ?? reason);
    this.name = "SourceError";
    this.reason = reason;
  }
}

export interface SourceInfo {
  readonly kind: SourceKind;
  readonly width: number;
  readonly height: number;
  /** 診断表示用の任意情報(実際に得られた解像度、facingMode など) */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * 画像の供給元。ここがデバイス境界。
 *
 * core/ はこのインターフェースすら知らない(純粋関数のまま)。
 * アプリ側が ImageSource から 1 枚受け取り、core/ に渡す。
 *
 * 実装:
 *   - LiveCameraSource   getUserMedia + video + canvas(唯一の撮影経路・無音)
 *   - FileImportSource   <input type="file">(撮影済みの写真を読み込む)
 *   - FixtureImageSource 合成書類を生成(実機なしでパイプライン全体を検証する)
 */
export interface ImageSource {
  readonly kind: SourceKind;
  start(): Promise<void>;
  capture(): Promise<Rgba>;
  stop(): void;
  info(): SourceInfo;
}
