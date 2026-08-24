/**
 * zlib(RFC 1950)ラップ付き deflate。
 * CompressionStream("deflate") の出力はそのまま PNG の IDAT と PDF の FlateDecode に入る。
 * ブラウザ(Safari 16.4+ / Chrome 80+)と Node 18+ の双方に存在するため、
 * このモジュールは実機なしでもテストできる。
 */
export async function deflateZlib(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
