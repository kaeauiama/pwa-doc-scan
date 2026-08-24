import { containFit, drawQuad, toDisplay, toSource } from "./render.ts";
import type { Point, Quad } from "../core/types.ts";

const HANDLE_RADIUS = 11;
/** 指で掴める範囲。見た目のハンドルより大きくする */
const GRAB_RADIUS = 30;

/**
 * 撮影画像の上に四隅のハンドルを出し、ドラッグで動かせるようにする(REQ-03)。
 *
 * 自動検出は色帯のある原稿で外すことがあり、しかもそのとき確信度が下がらない(D-028)。
 * そのため検出結果は常にこの編集画面を通す。誤検出が致命的にならないのはこの動線があるため。
 */
export class CornerEditor {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  #image: HTMLCanvasElement | null = null;
  #quad: Quad | null = null;
  #dragging = -1;
  #ratio = 1;

  onChange: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d コンテキストを取得できません");
    this.#ctx = ctx;

    canvas.addEventListener("pointerdown", this.#onDown);
    canvas.addEventListener("pointermove", this.#onMove);
    canvas.addEventListener("pointerup", this.#onUp);
    canvas.addEventListener("pointercancel", this.#onUp);
  }

  setImage(image: HTMLCanvasElement, quad: Quad): void {
    this.#image = image;
    this.#quad = quad;
    this.layout();
  }

  getQuad(): Quad {
    if (!this.#quad) throw new Error("CornerEditor: 画像が設定されていません");
    return this.#quad;
  }

  setQuad(quad: Quad): void {
    this.#quad = quad;
    this.render();
  }

  /** 表示領域に合わせて canvas の実ピクセル数を決める。回転や画面幅の変化で呼ぶ。 */
  layout(): void {
    const image = this.#image;
    if (!image) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const cssWidth = this.#canvas.clientWidth || image.width;
    const displayWidth = Math.min(cssWidth, image.width);
    const displayHeight = displayWidth * (image.height / image.width);

    this.#canvas.style.width = `${displayWidth}px`;
    this.#canvas.style.height = `${displayHeight}px`;
    this.#canvas.width = Math.round(displayWidth * ratio);
    this.#canvas.height = Math.round(displayHeight * ratio);
    this.#ratio = ratio;
    this.render();
  }

  render(): void {
    const image = this.#image;
    const quad = this.#quad;
    if (!image || !quad) return;
    const { width, height } = this.#canvas;
    const fit = containFit(image.width, image.height, width, height);

    this.#ctx.clearRect(0, 0, width, height);
    this.#ctx.drawImage(image, fit.offsetX, fit.offsetY, image.width * fit.scale, image.height * fit.scale);

    // 範囲外をうっすら暗くして、切り出される領域を分かりやすくする
    this.#ctx.save();
    this.#ctx.beginPath();
    this.#ctx.rect(0, 0, width, height);
    const pts = quad.map((p) => toDisplay(p, fit));
    this.#ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 3; i >= 1; i--) this.#ctx.lineTo(pts[i].x, pts[i].y);
    this.#ctx.closePath();
    this.#ctx.fillStyle = "rgba(0,0,0,0.45)";
    this.#ctx.fill("evenodd");
    this.#ctx.restore();

    drawQuad(this.#ctx, quad, fit, {
      stroke: "#22c55e",
      lineWidth: 2 * this.#ratio,
      handleRadius: HANDLE_RADIUS * this.#ratio,
    });
  }

  #eventPoint(event: PointerEvent): Point {
    const rect = this.#canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * this.#canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * this.#canvas.height,
    };
  }

  #fit() {
    const image = this.#image!;
    return containFit(image.width, image.height, this.#canvas.width, this.#canvas.height);
  }

  #onDown = (event: PointerEvent): void => {
    if (!this.#image || !this.#quad) return;
    const p = this.#eventPoint(event);
    const fit = this.#fit();
    let nearest = -1;
    let best = GRAB_RADIUS * this.#ratio;
    this.#quad.forEach((corner, i) => {
      const d = Math.hypot(p.x - toDisplay(corner, fit).x, p.y - toDisplay(corner, fit).y);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    if (nearest < 0) return;
    this.#dragging = nearest;
    this.#canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  #onMove = (event: PointerEvent): void => {
    if (this.#dragging < 0 || !this.#quad || !this.#image) return;
    const fit = this.#fit();
    const raw = toSource(this.#eventPoint(event), fit);
    // 画像の外へは出さない
    const clamped: Point = {
      x: Math.max(0, Math.min(this.#image.width, raw.x)),
      y: Math.max(0, Math.min(this.#image.height, raw.y)),
    };
    const next = [...this.#quad];
    next[this.#dragging] = clamped;
    this.#quad = next as unknown as Quad;
    this.render();
    event.preventDefault();
  };

  #onUp = (event: PointerEvent): void => {
    if (this.#dragging < 0) return;
    this.#dragging = -1;
    if (this.#canvas.hasPointerCapture(event.pointerId)) {
      this.#canvas.releasePointerCapture(event.pointerId);
    }
    this.onChange?.();
  };
}
