import type { Rgba } from "../core/types.ts";

/**
 * JPEG エンコーダ。ここもデバイス境界。
 *
 * ブラウザで JPEG を作るには canvas が要るため `core/` には置けない。
 * `core/pdf.ts` はエンコード済みのバイト列を受け取るだけにしてある(D-026)。
 */
export interface JpegEncoder {
  /** quality は 0..1 */
  encode(image: Rgba, quality: number): Promise<Uint8Array>;
}
