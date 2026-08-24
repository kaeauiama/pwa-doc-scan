import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { encodePng1bit } from "../core/png.ts";
import { bilevelPage, encodePdf, jpegPage } from "../core/pdf.ts";
import { packBits, rowBytesOf } from "../core/pack.ts";
import { makeIdealPage } from "./fixtures/synthetic.ts";

const page = makeIdealPage({ width: 620, height: 877, seed: 7 });

/** テスト用の固定データ。JPEG エンコーダを持たないので、実物のファイルを置いてある */
function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name)));
}

test("packBits: MSB 先頭で往復する", () => {
  const packed = packBits(page, false);
  const rowBytes = rowBytesOf(page.width);
  assert.equal(packed.length, rowBytes * page.height);
  let mismatch = 0;
  for (let y = 0; y < page.height; y++) {
    for (let x = 0; x < page.width; x++) {
      const bit = (packed[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (bit !== page.data[y * page.width + x]) mismatch++;
    }
  }
  assert.equal(mismatch, 0);
});

test("encodePng1bit: 構造・CRC・ビット往復が正しい", async () => {
  const png = await encodePng1bit(page, 200);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const chunks: { type: string; data: Buffer }[] = [];
  let p = 8;
  const buf = Buffer.from(png.buffer, png.byteOffset, png.length);
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    const crcGot = buf.readUInt32BE(p + 8 + len);
    const crcExp = zlib.crc32!(Buffer.concat([Buffer.from(type, "latin1"), data]));
    assert.equal(crcGot, crcExp, `CRC mismatch in ${type}`);
    chunks.push({ type, data });
    p += 12 + len;
  }
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "pHYs", "IDAT", "IEND"]);

  const ihdr = chunks[0].data;
  assert.equal(ihdr.readUInt32BE(0), page.width);
  assert.equal(ihdr.readUInt32BE(4), page.height);
  assert.equal(ihdr[8], 1, "bit depth = 1");
  assert.equal(ihdr[9], 0, "color type = grayscale");

  const raw = zlib.inflateSync(chunks.find((c) => c.type === "IDAT")!.data);
  const rowBytes = rowBytesOf(page.width);
  assert.equal(raw.length, (rowBytes + 1) * page.height);

  let mismatch = 0;
  for (let y = 0; y < page.height; y++) {
    assert.equal(raw[y * (rowBytes + 1)], 0, "filter byte");
    for (let x = 0; x < page.width; x++) {
      const bit = (raw[y * (rowBytes + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (bit !== page.data[y * page.width + x]) mismatch++;
    }
  }
  assert.equal(mismatch, 0);
});

test("encodePdf: 単一ページの xref とストリーム長が整合する", async () => {
  const pdf = await encodePdf([bilevelPage(page, 200)]);
  const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.length);
  const txt = buf.toString("latin1");

  assert.ok(txt.startsWith("%PDF-1.4"));
  const startxref = Number(txt.slice(txt.lastIndexOf("startxref") + 9).trim().split(/\s/)[0]);
  assert.equal(txt.slice(startxref, startxref + 4), "xref");

  const offs = [...txt.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offs.length, 5, "1 ページ = Catalog+Pages+Page+Image+Contents");
  offs.forEach((o, i) => {
    assert.equal(txt.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
  });

  const m = txt.match(/\/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/)!;
  const declared = Number(m[1]);
  const s = txt.indexOf("stream\n", m.index!) + 7;
  const e = txt.indexOf("\nendstream", s);
  assert.equal(e - s, declared, "画像ストリームの /Length");

  const imgRaw = zlib.inflateSync(buf.subarray(s, e));
  assert.equal(imgRaw.length, rowBytesOf(page.width) * page.height);
  assert.deepEqual(Uint8Array.from(imgRaw), packBits(page, false));
});

test("encodePdf: 複数ページでも xref が全オブジェクトを指す", async () => {
  const small = makeIdealPage({ width: 200, height: 280, seed: 3 });
  const pdf = await encodePdf([bilevelPage(page, 200), bilevelPage(small, 150), bilevelPage(small, 300)]);
  const txt = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.length).toString("latin1");
  const startxref = Number(txt.slice(txt.lastIndexOf("startxref") + 9).trim().split(/\s/)[0]);
  const offs = [...txt.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offs.length, 2 + 3 * 3);
  offs.forEach((o, i) => {
    assert.equal(txt.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
  });
  assert.match(txt, /\/Kids \[3 0 R 6 0 R 9 0 R\] \/Count 3/);
});

test("encodePdf: 空ページ配列は明示的に失敗する", async () => {
  await assert.rejects(() => encodePdf([]), /ページが空/);
});

test("encodePdf: JPEG ページを DCTDecode で埋め、バイト列をそのまま保つ", async () => {
  // 実物の JPEG(src/test/fixtures/tiny.jpg)。エンコーダは持たないので固定データを使う
  const jpeg = readFixture("tiny.jpg");
  assert.equal(jpeg[0], 0xff, "JPEG の SOI マーカー");
  assert.equal(jpeg[1], 0xd8);

  const pdf = await encodePdf([jpegPage(jpeg, 64, 48, 200)]);
  const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.length);
  const txt = buf.toString("latin1");

  assert.match(txt, /\/Filter \/DCTDecode/);
  assert.match(txt, /\/ColorSpace \/DeviceRGB \/BitsPerComponent 8/);
  assert.match(txt, /\/Width 64 \/Height 48/);
  // 64px を 200dpi で置くと 23.04pt
  assert.match(txt, /\/MediaBox \[0 0 23\.04 17\.28\]/);

  const m = txt.match(/\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/);
  assert.ok(m, "画像オブジェクトが見つかる");
  const declared = Number(m[1]);
  assert.equal(declared, jpeg.length, "JPEG は再圧縮せずそのまま埋める");
  const start = txt.indexOf("stream\n", m.index) + 7;
  assert.deepEqual(Uint8Array.from(buf.subarray(start, start + declared)), jpeg, "バイト列が一致する");

  // xref の整合も崩れていないこと
  const startxref = Number(txt.slice(txt.lastIndexOf("startxref") + 9).trim().split(/\s/)[0]);
  assert.equal(txt.slice(startxref, startxref + 4), "xref");
  const offs = [...txt.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((x) => Number(x[1]));
  offs.forEach((o, i) => assert.equal(txt.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
});

test("encodePdf: 白黒2値と JPEG のページを混在できる", async () => {
  const jpeg = readFixture("tiny.jpg");
  const pdf = await encodePdf([bilevelPage(page, 200), jpegPage(jpeg, 64, 48, 200)]);
  const txt = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.length).toString("latin1");
  assert.match(txt, /\/Kids \[3 0 R 6 0 R\] \/Count 2/);
  assert.match(txt, /\/Filter \/FlateDecode/);
  assert.match(txt, /\/Filter \/DCTDecode/);
});
