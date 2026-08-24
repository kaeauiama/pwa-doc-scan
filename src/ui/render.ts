import type { Bilevel, Point, Quad, Rgba } from "../core/types.ts";

/** Rgba をそのまま canvas に描く */
export function rgbaToCanvas(image: Rgba, target?: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = target ?? document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d コンテキストを取得できません");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return canvas;
}

/** 1 = 白 / 0 = 黒 の二値画像を canvas に描く */
export function bilevelToCanvas(image: Bilevel, target?: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = target ?? document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d コンテキストを取得できません");
  const out = ctx.createImageData(image.width, image.height);
  for (let i = 0, j = 0; i < image.data.length; i++, j += 4) {
    const v = image.data[i] ? 255 : 0;
    out.data[j] = v;
    out.data[j + 1] = v;
    out.data[j + 2] = v;
    out.data[j + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/**
 * `object-fit: contain` で表示された映像の、表示座標系と映像座標系の対応。
 * オーバーレイに枠を描くとき、映像の実サイズと表示サイズがずれるので必要になる。
 */
export interface FitBox {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scale: number;
}

export function containFit(
  sourceWidth: number,
  sourceHeight: number,
  boxWidth: number,
  boxHeight: number,
): FitBox {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { offsetX: 0, offsetY: 0, scale: 1 };
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  return {
    offsetX: (boxWidth - sourceWidth * scale) / 2,
    offsetY: (boxHeight - sourceHeight * scale) / 2,
    scale,
  };
}

export function toDisplay(p: Point, fit: FitBox): Point {
  return { x: fit.offsetX + p.x * fit.scale, y: fit.offsetY + p.y * fit.scale };
}

export function toSource(p: Point, fit: FitBox): Point {
  return { x: (p.x - fit.offsetX) / fit.scale, y: (p.y - fit.offsetY) / fit.scale };
}

export interface QuadStyle {
  readonly stroke: string;
  readonly fill?: string;
  readonly lineWidth: number;
  readonly handleRadius?: number;
}

/** 四角形を描く。handleRadius を渡すと四隅にハンドルも描く。 */
export function drawQuad(
  ctx: CanvasRenderingContext2D,
  quad: Quad,
  fit: FitBox,
  style: QuadStyle,
): void {
  const points = quad.map((p) => toDisplay(p, fit));
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  if (style.fill) {
    ctx.fillStyle = style.fill;
    ctx.fill();
  }
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = style.lineWidth;
  ctx.lineJoin = "round";
  ctx.stroke();

  if (style.handleRadius) {
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, style.handleRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = style.lineWidth;
      ctx.strokeStyle = style.stroke;
      ctx.stroke();
    }
  }
  ctx.restore();
}
