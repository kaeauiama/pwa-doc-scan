import { SourceError } from "../ports/ImageSource.ts";
import type { ImageSource, SourceInfo } from "../ports/ImageSource.ts";
import type { Rgba } from "../core/types.ts";

/**
 * すでに撮影済みの画像ファイルを読み込む(D-020)。
 *
 * 元は「高画質モード」だったが、実機で `getUserMedia` が静止画経路と同一の
 * 12.2MP を返したため、解像度を理由にこの経路を使う意味は無くなった。
 * 残しているのは「写真アプリにある画像をスキャンしたい」という別の用途のため。
 *
 * 注: `<input type="file" capture="environment">` にするとシステムカメラが起動し、
 * 日本版 iPhone ではシャッター音が鳴る。capture 属性は付けないこと。
 */
export class FileImportSource implements ImageSource {
  readonly kind = "file-import" as const;

  readonly #file: File;
  #frame: Rgba | null = null;

  constructor(file: File) {
    this.#file = file;
  }

  async start(): Promise<void> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(this.#file);
    } catch (err) {
      throw new SourceError("DECODE_FAILED", err instanceof Error ? err.message : String(err));
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new SourceError("FAILED_UNKNOWN", "2d コンテキストを取得できません");
      ctx.drawImage(bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      this.#frame = { width: bitmap.width, height: bitmap.height, data: image.data };
    } finally {
      bitmap.close();
    }
  }

  async capture(): Promise<Rgba> {
    if (!this.#frame) throw new SourceError("NOT_STARTED");
    return this.#frame;
  }

  stop(): void {
    this.#frame = null;
  }

  info(): SourceInfo {
    return {
      kind: this.kind,
      width: this.#frame?.width ?? 0,
      height: this.#frame?.height ?? 0,
      detail: {
        filename: this.#file.name,
        mimeType: this.#file.type,
        bytes: this.#file.size,
      },
    };
  }
}
