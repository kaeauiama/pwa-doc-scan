import { measureSharpness } from "./src/core/sharpness.ts";
import { gaussianBlur } from "./src/core/edges.ts";
import { rgbaToGray } from "./src/core/gray.ts";
import { makeDocumentPhoto, makeIdealPage } from "./src/test/fixtures/synthetic.ts";
import type { Gray8 } from "./src/core/types.ts";

/** 紙面をそのまま高解像度のグレー画像にする(撮影後の切り出し相当) */
function pageAsGray(strokePitch: number, width = 1654, height = 2339): Gray8 {
  const page = makeIdealPage({ width, height, seed: 7, strokePitch });
  const data = new Uint8Array(width * height);
  for (let i = 0; i < page.data.length; i++) data[i] = page.data[i] ? 240 : 40;
  return { width, height, data };
}

console.log("== 文字の太さ x ぼかし回数 ==");
console.log("pitch  " + [0,1,2,3,4,6].map(n => `blur x${n}`.padStart(9)).join(""));
for (const pitch of [6, 12, 24, 48]) {
  const base = pageAsGray(pitch);
  const row: string[] = [];
  let img = base;
  for (let n = 0; n <= 6; n++) {
    if (n > 0) img = gaussianBlur(img);
    if ([0,1,2,3,4,6].includes(n)) {
      const r = measureSharpness(img);
      row.push(`${r.score.toFixed(3)}`.padStart(9));
    }
  }
  console.log(String(pitch).padEnd(7) + row.join(""));
}

console.log("\n== 余白だけ(判定不能になるべき) ==");
const blank: Gray8 = { width: 1200, height: 1600, data: new Uint8Array(1200*1600).fill(238) };
const rb = measureSharpness(blank);
console.log(`verdict=${rb.verdict} score=${rb.score.toFixed(3)} contrast=${rb.contrast.toFixed(1)}`);

console.log("\n== 合成写真(机+影+ノイズ)を撮ったまま測る ==");
for (const noise of [4, 12, 24]) {
  const f = makeDocumentPhoto(
    { width: 620, height: 877, seed: 42, strokePitch: 6 },
    { width: 3024, height: 4032, shading: 0.5, noise, seed: 21 },
  );
  let g = rgbaToGray(f.photo);
  for (const n of [0, 2, 4]) {
    let img = g;
    for (let i = 0; i < n; i++) img = gaussianBlur(img);
    const r = measureSharpness(img);
    console.log(`  noise=${String(noise).padStart(2)} blur x${n}: ${r.verdict.padEnd(7)} score=${r.score.toFixed(3)} contrast=${r.contrast.toFixed(0)}`);
  }
}
