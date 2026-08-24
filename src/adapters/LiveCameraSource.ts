import { SourceError } from "../ports/ImageSource.ts";
import type { ImageSource, SourceInfo } from "../ports/ImageSource.ts";
import type { Rgba } from "../core/types.ts";

/**
 * 低解像度で流す場合の制約。既定では使わない(D-025)。
 * 最大解像度で 30fps が出ない端末向けの逃げ道。
 */
export const PREVIEW_CONSTRAINT: MediaTrackConstraints = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

/**
 * 撮影用。センサーの最大解像度を要求する。
 * 実機(iOS 18.7 / Safari 26.6)では 4032x3024 / 12.2MP / A4 実効 366dpi が返った。
 * 制約を省くと 640x480 に落ちるので、必ず明示すること(D-024)。
 */
export const CAPTURE_CONSTRAINT: MediaTrackConstraints = {
  width: { ideal: 99999 },
  height: { ideal: 99999 },
};

export interface LiveCameraOptions {
  /** プレビューを描画する video 要素。HC-2 のため、可視であることが撮影の前提 */
  video: HTMLVideoElement;
  previewConstraint?: MediaTrackConstraints;
  captureConstraint?: MediaTrackConstraints;
  /**
   * シャッター時だけ解像度を上げるか。**既定は false**(D-025)。
   *
   * 実機計測では最大解像度でも 30.2fps・発熱なしだった一方、切り替えは片道 約450ms
   * かかり、その間プレビューが実質停止する(切り替え中に届いたフレームは 2 枚)。
   * 往復で毎ショット約 900ms を払って得るものが無いため、切り替えない。
   * 低スペック端末で最大解像度が流せない場合の逃げ道としてだけ残してある。
   */
  switchOnCapture?: boolean;
  /** 解像度切り替え後、映像が実際に切り替わるのを待つ上限 */
  switchTimeoutMs?: number;
}

function mapError(err: unknown): SourceError {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new SourceError("PERMISSION_DENIED", message);
    case "NotFoundError":
    case "DevicesNotFoundError":
      return new SourceError("NO_CAMERA", message);
    case "NotReadableError":
    case "TrackStartError":
      return new SourceError("CAMERA_BUSY", message);
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return new SourceError("UNSUPPORTED_CONSTRAINTS", message);
    default:
      return new SourceError("FAILED_UNKNOWN", `${name}: ${message}`);
  }
}

/**
 * getUserMedia + canvas でフレームを取り出す。唯一の撮影経路(D-020)。
 *
 * OS の静止画撮影 API を通らないため撮影音が鳴らない。これは PWA を選んだことの
 * 副次的な性質であって目的ではない(HC-1)。
 * 撮影は可視のプレビューが出ている間だけ許可する(HC-2 のガード)。
 */
export class LiveCameraSource implements ImageSource {
  readonly kind = "live-camera" as const;

  readonly #video: HTMLVideoElement;
  readonly #preview: MediaTrackConstraints;
  readonly #capture: MediaTrackConstraints;
  readonly #switchOnCapture: boolean;
  readonly #switchTimeoutMs: number;

  #stream: MediaStream | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #lastCaptureSize: { width: number; height: number } | null = null;
  #lastSwitchMs = 0;

  constructor(options: LiveCameraOptions) {
    this.#video = options.video;
    this.#preview = options.previewConstraint ?? PREVIEW_CONSTRAINT;
    this.#capture = options.captureConstraint ?? CAPTURE_CONSTRAINT;
    this.#switchOnCapture = options.switchOnCapture ?? false;
    this.#switchTimeoutMs = options.switchTimeoutMs ?? 8000;
  }

  #track(): MediaStreamTrack | null {
    const tracks = this.#stream?.getVideoTracks();
    return tracks && tracks.length > 0 ? tracks[0] : null;
  }

  async start(): Promise<void> {
    if (!globalThis.isSecureContext) {
      throw new SourceError("UNSUPPORTED_INSECURE_CONTEXT", "HTTPS でないとカメラを使えません");
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new SourceError("UNSUPPORTED_NO_GETUSERMEDIA");
    }
    try {
      const constraint = this.#switchOnCapture ? this.#preview : this.#capture;
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: false, // 音声トラックは一切要求しない(NG-05)
        video: { facingMode: { ideal: "environment" }, ...constraint },
      });
      this.#video.srcObject = this.#stream;
      this.#video.playsInline = true;
      this.#video.muted = true;
      await this.#video.play();
    } catch (err) {
      this.stop();
      throw mapError(err);
    }
  }

  /** 映像が track の設定どおりのサイズになるまで待つ。切り替えの完了判定。 */
  async #waitForSize(): Promise<void> {
    const track = this.#track();
    if (!track) return;
    const deadline = performance.now() + this.#switchTimeoutMs;
    while (performance.now() < deadline) {
      const s = track.getSettings();
      if (this.#video.videoWidth === s.width && this.#video.videoHeight === s.height) return;
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
  }

  async capture(): Promise<Rgba> {
    const track = this.#track();
    if (!track) throw new SourceError("NOT_STARTED");

    // HC-2: 可視のプレビューが出ていない状態では撮影させない
    if (document.visibilityState !== "visible") {
      throw new SourceError("NOT_STARTED", "画面が表示されていないため撮影しません");
    }
    if (this.#video.videoWidth === 0 || this.#video.videoHeight === 0) {
      throw new SourceError("NOT_STARTED", "プレビューがまだ表示されていません");
    }

    if (this.#switchOnCapture) {
      const t0 = performance.now();
      try {
        await track.applyConstraints(this.#capture);
        await this.#waitForSize();
      } catch (err) {
        // 切り替えに失敗してもプレビュー解像度で撮る。黙って落とさない
        console.warn("撮影解像度への切り替えに失敗しました", err);
      }
      this.#lastSwitchMs = Math.round(performance.now() - t0);
    }

    const width = this.#video.videoWidth;
    const height = this.#video.videoHeight;
    if (!this.#canvas) this.#canvas = document.createElement("canvas");
    this.#canvas.width = width;
    this.#canvas.height = height;
    const ctx = this.#canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new SourceError("FAILED_UNKNOWN", "2d コンテキストを取得できません");
    ctx.drawImage(this.#video, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    this.#lastCaptureSize = { width, height };

    if (this.#switchOnCapture) {
      try {
        await track.applyConstraints(this.#preview);
      } catch {
        /* プレビューに戻せなくても撮影自体は成立している */
      }
    }

    return { width, height, data: image.data };
  }

  /** torch(ライト)を制御できるか。iOS 18.7 実機では true だった */
  isTorchAvailable(): boolean {
    const track = this.#track();
    if (!track || !track.getCapabilities) return false;
    const caps = track.getCapabilities() as { torch?: boolean };
    return caps.torch === true;
  }

  async setTorch(on: boolean): Promise<boolean> {
    const track = this.#track();
    if (!track || !this.isTorchAvailable()) return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    const stream = this.#stream;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#video.srcObject = null;
  }

  info(): SourceInfo {
    const settings = this.#track()?.getSettings();
    return {
      kind: this.kind,
      width: this.#lastCaptureSize?.width ?? settings?.width ?? 0,
      height: this.#lastCaptureSize?.height ?? settings?.height ?? 0,
      detail: {
        streaming: this.#stream !== null,
        streamWidth: settings?.width ?? 0,
        streamHeight: settings?.height ?? 0,
        frameRate: settings?.frameRate ?? 0,
        facingMode: settings?.facingMode ?? "?",
        switchOnCapture: this.#switchOnCapture,
        lastSwitchMs: this.#lastSwitchMs,
        torchAvailable: this.isTorchAvailable(),
      },
    };
  }
}
