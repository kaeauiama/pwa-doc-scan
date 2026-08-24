import { compactPage, encodePdf } from "./core/pdf.ts";
import type { PdfPage } from "./core/pdf.ts";
import type { RenderMode } from "./pipeline.ts";

export interface PageMeta {
  readonly mode: RenderMode;
  readonly dpi: number;
  readonly width: number;
  readonly height: number;
  /** PDF に埋まるバイト数の目安 */
  readonly byteSize: number;
}

export interface CollectedPage {
  readonly id: string;
  readonly page: PdfPage;
  readonly meta: PageMeta;
}

function sizeOf(page: PdfPage): number {
  const image = page.image;
  if (image.kind === "bilevel") return Math.ceil(image.image.width / 8) * image.image.height;
  return image.bytes.length;
}

/**
 * 撮り溜めたページ(REQ-10)。
 *
 * **端末内には保存しない。** 保持はメモリ上だけで、PDF にまとめて書き出したら捨てる。
 * 溜め込む場所を持たない方針(D-005)を保ったまま、1 回のセッションの中でだけ束ねる。
 * 追加時に `compactPage` を通すので、白黒2値 1 枚あたり約 3.9MB ではなく数十 KB で済む。
 */
export class PageCollection {
  #items: CollectedPage[] = [];
  #counter = 0;

  get size(): number {
    return this.#items.length;
  }

  /** 保持しているページ合計の概算バイト数 */
  get byteSize(): number {
    return this.#items.reduce((sum, item) => sum + item.meta.byteSize, 0);
  }

  list(): readonly CollectedPage[] {
    return this.#items;
  }

  async add(page: PdfPage, mode: RenderMode, dpi: number, width: number, height: number): Promise<string> {
    const compact = await compactPage(page);
    const id = `p${++this.#counter}`;
    this.#items.push({
      id,
      page: compact,
      meta: { mode, dpi, width, height, byteSize: sizeOf(compact) },
    });
    return id;
  }

  remove(id: string): boolean {
    const index = this.#items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.#items.splice(index, 1);
    return true;
  }

  /** delta ぶん前後に動かす。端では何もしない。 */
  move(id: string, delta: number): boolean {
    const from = this.#items.findIndex((item) => item.id === id);
    if (from < 0) return false;
    const to = from + delta;
    if (to < 0 || to >= this.#items.length) return false;
    const [item] = this.#items.splice(from, 1);
    this.#items.splice(to, 0, item);
    return true;
  }

  clear(): void {
    this.#items = [];
  }

  /** 保持している順で 1 つの PDF にまとめる */
  async toPdf(): Promise<Uint8Array> {
    if (this.#items.length === 0) throw new Error("ページがありません");
    return encodePdf(this.#items.map((item) => item.page));
  }
}
