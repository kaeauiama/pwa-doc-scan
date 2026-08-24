import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PageCollection } from "../pages.ts";
import { bilevelPage, compactPage, encodePdf, jpegPage } from "../core/pdf.ts";
import { packBits } from "../core/pack.ts";
import { makeIdealPage } from "./fixtures/synthetic.ts";

const page = makeIdealPage({ width: 620, height: 877, seed: 7 });
const jpeg = new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", "tiny.jpg")));

test("compactPage: 圧縮しても出来上がる PDF は完全に同じ", async () => {
  const original = bilevelPage(page, 200);
  const compact = await compactPage(original);
  assert.equal(compact.image.kind, "bilevel-flate");

  const a = await encodePdf([original]);
  const b = await encodePdf([compact]);
  assert.deepEqual([...a], [...b], "バイト列が一致すること");
});

test("compactPage: 保持サイズが 2 桁小さくなる", async () => {
  const compact = await compactPage(bilevelPage(page, 200));
  assert.equal(compact.image.kind, "bilevel-flate");
  if (compact.image.kind !== "bilevel-flate") return;
  const raw = page.width * page.height;
  assert.ok(compact.image.bytes.length < raw / 50, `生 ${raw}B に対し圧縮後 ${compact.image.bytes.length}B`);
  // 中身も正しいこと
  const inflated = zlib.inflateSync(Buffer.from(compact.image.bytes));
  assert.deepEqual(Uint8Array.from(inflated), packBits(page, false));
});

test("compactPage: JPEG ページは触らない", async () => {
  const original = jpegPage(jpeg, 64, 48, 200);
  const compact = await compactPage(original);
  assert.equal(compact, original, "同じオブジェクトを返す");
});

test("PageCollection: 追加した順に PDF になる", async () => {
  const pages = new PageCollection();
  assert.equal(pages.size, 0);
  await pages.add(bilevelPage(page, 200), "bilevel", 200, page.width, page.height);
  await pages.add(jpegPage(jpeg, 64, 48, 150), "color", 150, 64, 48);
  assert.equal(pages.size, 2);

  const pdf = await pages.toPdf();
  const txt = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.length).toString("latin1");
  assert.match(txt, /\/Kids \[3 0 R 6 0 R\] \/Count 2/);
  assert.match(txt, /\/Filter \/FlateDecode/);
  assert.match(txt, /\/Filter \/DCTDecode/);
});

test("PageCollection: 並べ替えと削除", async () => {
  const pages = new PageCollection();
  const a = await pages.add(bilevelPage(page, 200), "bilevel", 200, 1, 1);
  const b = await pages.add(bilevelPage(page, 200), "bilevel", 200, 2, 2);
  const c = await pages.add(bilevelPage(page, 200), "bilevel", 200, 3, 3);
  const ids = () => pages.list().map((item) => item.id);

  assert.deepEqual(ids(), [a, b, c]);
  assert.equal(pages.move(c, -1), true);
  assert.deepEqual(ids(), [a, c, b]);
  assert.equal(pages.move(a, -1), false, "先頭より前には動かない");
  assert.equal(pages.move(b, 1), false, "末尾より後ろには動かない");
  assert.deepEqual(ids(), [a, c, b]);

  assert.equal(pages.remove(c), true);
  assert.deepEqual(ids(), [a, b]);
  assert.equal(pages.remove("存在しない"), false);
  assert.equal(pages.size, 2);
});

test("PageCollection: 空なら明示的に失敗する", async () => {
  const pages = new PageCollection();
  await assert.rejects(() => pages.toPdf(), /ページがありません/);
});

test("PageCollection: 保持サイズを合算して報告する", async () => {
  const pages = new PageCollection();
  await pages.add(bilevelPage(page, 200), "bilevel", 200, page.width, page.height);
  await pages.add(jpegPage(jpeg, 64, 48, 200), "color", 200, 64, 48);
  const list = pages.list();
  assert.equal(pages.byteSize, list[0].meta.byteSize + list[1].meta.byteSize);
  assert.equal(list[1].meta.byteSize, jpeg.length);
  // 白黒2値 A4 相当が数十 KB に収まっていること(生なら 540KB 超)
  assert.ok(list[0].meta.byteSize < 60_000, `${list[0].meta.byteSize} bytes`);
});

test("PageCollection: clear で全部捨てる(端末に残さない)", async () => {
  const pages = new PageCollection();
  await pages.add(bilevelPage(page, 200), "bilevel", 200, 1, 1);
  pages.clear();
  assert.equal(pages.size, 0);
  assert.equal(pages.byteSize, 0);
});
