import { boundingQuad } from "../core/warp.ts";
import { EDGE_HANDLE_START, HANDLE_COUNT, handlePosition, moveHandle } from "../core/crop.ts";
import { containFit, drawQuad, toDisplay, toSource } from "./render.ts";
import type { CropMode } from "../core/crop.ts";
import type { Point, Quad } from "../core/types.ts";

export type { CropMode };

const CORNER_RADIUS = 11;
const EDGE_RADIUS = 9;
/** 指で掴める範囲。見た目のハンドルより大きくする */
const GRAB_RADIUS = 30;

/**
 * 撮影画像の上にハンドルを出し、切り抜き範囲をドラッグで決める(REQ-03 / REQ-26)。
 *
 * 自動検出は色帯のある原稿で外すことがあり、しかもそのとき確信度が下がらない(D-028)。
 * そのため検出結果は常にこの編集画面を通す。誤検出が致命的にならないのはこの動線があるため。
 */
export class CornerEditor {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  #image: HTMLCanvasElement | null = null;
  #quad: Quad | null = null;
  #mode: CropMode = "quad";
  #dragging = -1;
  /** ドラッグ開始時の指の位置と四隅。辺の移動量を出すのに使う */
  #dragOrigin: { point: Point; quad: Quad } | null = null;
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
    this.#quad = this.#mode === "rect" ? boundingQuad(quad) : quad;
    this.layout();
  }

  getQuad(): Quad {
    if (!this.#quad) throw new Error("CornerEditor: 画像が設定されていません");
    return this.#quad;
  }

  setQuad(quad: Quad): void {
    this.#quad = this.#mode === "rect" ? boundingQuad(quad) : quad;
    this.render();
  }

  getMode(): CropMode {
    return this.#mode;
  }

  /**
   * 切り抜きの方法を変える。
   * `rect` にするときは、いまの範囲を囲む最小の矩形にそろえる。
   * `quad` に戻すときは形をそのまま引き継ぐ(矩形は四角形の一種なので情報を失わない)。
   */
  setMode(mode: CropMode): void {
    if (this.#mode === mode) return;
    this.#mode = mode;
    if (mode === "rect" && this.#quad) this.#quad = boundingQuad(this.#quad);
    this.render();
  }

  /**
   * 表示領域に合わせて canvas の実ピクセル数を決める。回転や画面幅の変化で呼ぶ。
   *
   * 幅だけで決めると、縦長の写真で下側がビューポートからはみ出し、
   * 下の四隅に指が届かなくなる。高さの上限も見て両方に収める。
   */
  layout(): void {
    const image = this.#image;
    if (!image) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const boxWidth = this.#canvas.parentElement?.clientWidth ?? 0;
    if (boxWidth <= 0) return;
    const boxHeight = Math.max(240, Math.round((globalThis.innerHeight || 800) * 0.46));
    const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
    const displayWidth = Math.max(1, Math.round(image.width * scale));
    const displayHeight = Math.max(1, Math.round(image.height * scale));

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

    drawQuad(this.#ctx, quad, fit, { stroke: "#22c55e", lineWidth: 2 * this.#ratio });

    for (const p of pts) this.#drawHandle(p, CORNER_RADIUS * this.#ratio, false);
    for (let edge = 0; edge < 4; edge++) {
      this.#drawHandle(toDisplay(handlePosition(quad, EDGE_HANDLE_START + edge), fit), EDGE_RADIUS * this.#ratio, true);
    }
  }

  /** 隅は丸、辺は角丸の四角。掴んだときの効き方が違うので見た目でも分ける */
  #drawHandle(p: Point, radius: number, isEdge: boolean): void {
    const ctx = this.#ctx;
    ctx.save();
    ctx.beginPath();
    if (isEdge) {
      const r = radius * 0.9;
      if (typeof ctx.roundRect === "function") ctx.roundRect(p.x - r, p.y - r, r * 2, r * 2, r * 0.45);
      else ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
    } else {
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2 * this.#ratio;
    ctx.strokeStyle = "#22c55e";
    ctx.stroke();
    ctx.restore();
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
    const quad = this.#quad;
    if (!this.#image || !quad) return;
    const p = this.#eventPoint(event);
    const fit = this.#fit();
    const limit = GRAB_RADIUS * this.#ratio;

    let nearest = -1;
    let best = limit;
    // 隅を優先する。辺の中点は隅と近いことがあるため
    quad.forEach((corner, i) => {
      const d = Math.hypot(p.x - toDisplay(corner, fit).x, p.y - toDisplay(corner, fit).y);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    if (nearest < 0) {
      for (let handle = EDGE_HANDLE_START; handle < HANDLE_COUNT; handle++) {
        const mid = toDisplay(handlePosition(quad, handle), fit);
        const d = Math.hypot(p.x - mid.x, p.y - mid.y);
        if (d < best) {
          best = d;
          nearest = handle;
        }
      }
    }
    if (nearest < 0) return;

    this.#dragging = nearest;
    this.#dragOrigin = { point: toSource(p, fit), quad };
    this.#canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  #onMove = (event: PointerEvent): void => {
    const origin = this.#dragOrigin;
    const image = this.#image;
    if (this.#dragging < 0 || !origin || !image) return;

    const here = toSource(this.#eventPoint(event), this.#fit());
    const delta: Point = { x: here.x - origin.point.x, y: here.y - origin.point.y };

    this.#quad = moveHandle(
      this.#mode,
      origin.quad,
      this.#dragging,
      here,
      delta,
      image.width,
      image.height,
    );

    this.render();
    event.preventDefault();
  };

  #onUp = (event: PointerEvent): void => {
    if (this.#dragging < 0) return;
    this.#dragging = -1;
    this.#dragOrigin = null;
    if (this.#canvas.hasPointerCapture(event.pointerId)) {
      this.#canvas.releasePointerCapture(event.pointerId);
    }
    this.onChange?.();
  };
}
