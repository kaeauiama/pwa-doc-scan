import type { JpegEncoder } from "../ports/JpegEncoder.ts";
import type { Rgba } from "../core/types.ts";

/**
 * canvas.toBlob による JPEG エンコード。
 *
 * 注: canvas が出す JPEG は常に 3 チャンネル。グレースケール画像を渡しても
 * DeviceGray にはならないので、PDF 側は DeviceRGB として扱うこと(core/pdf.ts 参照)。
 * 色差成分が平坦になるため、サイズ上の不利はほとんどない。
 *
 * 実機で `toBlob("image/webp")` は false だったため、WebP には頼らない。
 */
export class CanvasJpegEncoder implements JpegEncoder {
  async encode(image: Rgba, quality: number): Promise<Uint8Array> {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d コンテキストを取得できません");

    // ImageData は自前の ArrayBuffer を要求するので、必ずコピーを渡す
    const data = new Uint8ClampedArray(image.data);
    ctx.putImageData(new ImageData(data, image.width, image.height), 0, 0);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
    if (!blob) throw new Error("JPEG のエンコードに失敗しました");
    return new Uint8Array(await blob.arrayBuffer());
  }
}
