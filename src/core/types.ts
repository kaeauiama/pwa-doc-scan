/** デバイス非依存の基本型。DOM / カメラ / Canvas への依存をここに持ち込まないこと。 */

export interface Rgba {
  readonly width: number;
  readonly height: number;
  /** RGBA 各 8bit、長さ = width * height * 4 */
  readonly data: Uint8ClampedArray | Uint8Array;
}

export interface Gray8 {
  readonly width: number;
  readonly height: number;
  /** 0..255、長さ = width * height */
  readonly data: Uint8Array;
}

/** 二値画像。1 = 白(紙)、0 = 黒(インク)。PNG / PDF の 1bit DeviceGray と同じ極性。 */
export interface Bilevel {
  readonly width: number;
  readonly height: number;
  /** 各要素は 0 か 1。長さ = width * height */
  readonly data: Uint8Array;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 書類の四隅。左上→右上→右下→左下 の順で固定する。 */
export type Quad = readonly [Point, Point, Point, Point];

/** 3x3 の射影変換行列(行優先) */
export type Matrix3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];
