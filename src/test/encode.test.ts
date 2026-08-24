import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { encodePng1bit } from "../core/png.ts";
import { encodePdf1bit } from "../core/pdf.ts";
import { packBits, rowBytesOf } from "../core/pack.ts";
import { makeIdealPage } from "./fixtures/synthetic.ts";

const page = makeIdealPage({ width: 620, height: 877, seed: 7 });

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

test("encodePdf1bit: 単一ページの xref とストリーム長が整合する", async () => {
  const pdf = await encodePdf1bit([{ image: page, dpi: 200 }]);
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

test("encodePdf1bit: 複数ページでも xref が全オブジェクトを指す", async () => {
  const small = makeIdealPage({ width: 200, height: 280, seed: 3 });
  const pdf = await encodePdf1bit([
    { image: page, dpi: 200 },
    { image: small, dpi: 150 },
    { image: small, dpi: 300 },
  ]);
  const txt = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.length).toString("latin1");
  const startxref = Number(txt.slice(txt.lastIndexOf("startxref") + 9).trim().split(/\s/)[0]);
  const offs = [...txt.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offs.length, 2 + 3 * 3);
  offs.forEach((o, i) => {
    assert.equal(txt.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
  });
  assert.match(txt, /\/Kids \[3 0 R 6 0 R 9 0 R\] \/Count 3/);
});

test("encodePdf1bit: 空ページ配列は明示的に失敗する", async () => {
  await assert.rejects(() => encodePdf1bit([]), /ページが空/);
});
