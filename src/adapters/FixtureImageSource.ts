import type { ImageSource, SourceInfo } from "../ports/ImageSource.ts";
import type { Rgba } from "../core/types.ts";

/**
 * 合成書類を供給する ImageSource。カメラも DOM も使わないため Node で動く。
 * これがあるおかげで、実機なしでも撮影以降のパイプライン全体を検証できる。
 *
 * 注: Node の型ストリッピングで動かすため、コンストラクタのパラメータプロパティ
 * (constructor(private x) 記法)は使わない。あれは型消去では表現できない。
 */
export class FixtureImageSource implements ImageSource {
  readonly kind = "fixture" as const;
  readonly #frame: Rgba;
  readonly #label: string;
  #started = false;

  constructor(frame: Rgba, label = "synthetic") {
    this.#frame = frame;
    this.#label = label;
  }

  async start(): Promise<void> {
    this.#started = true;
  }

  async capture(): Promise<Rgba> {
    if (!this.#started) throw new Error("FixtureImageSource: start() されていません");
    return this.#frame;
  }

  stop(): void {
    this.#started = false;
  }

  info(): SourceInfo {
    return {
      kind: this.kind,
      width: this.#frame.width,
      height: this.#frame.height,
      detail: { label: this.#label, started: this.#started },
    };
  }
}
