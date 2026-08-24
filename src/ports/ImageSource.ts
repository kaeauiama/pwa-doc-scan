import type { Rgba } from "../core/types.ts";

export type SourceKind = "live-camera" | "system-camera" | "fixture";

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
 *   - LiveCameraSource   getUserMedia + video + canvas(無音モード)
 *   - FileCaptureSource  <input type="file" capture>(高画質モード)
 *   - FixtureImageSource 合成書類を生成(実機なしでパイプライン全体を検証する)
 */
export interface ImageSource {
  readonly kind: SourceKind;
  start(): Promise<void>;
  capture(): Promise<Rgba>;
  stop(): void;
  info(): SourceInfo;
}
