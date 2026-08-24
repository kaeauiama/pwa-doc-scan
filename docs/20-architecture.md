# アーキテクチャ:デバイス境界の切り方

最終更新: 2026-08-24

`00-scope-and-constraints.md` と矛盾する場合はそちらが正。

---

## 1. なぜこの形にしたか

実機がなくても開発と検証を進められるようにするため、**デバイスに触る場所を 3 つの
アダプタに閉じ込め、それ以外を全部純粋関数にした**。

前提として、M0 の時点で 1bit PNG / PDF エンコーダを Node で検証できたのは、
DI でもモックでもなく **その関数群にそもそもデバイス依存が無かった**から。
`Uint8Array` を受けて `Uint8Array` を返すだけで、唯一使う Web API である
`CompressionStream` と `TextEncoder` は Node にも存在する。

この性質を偶然に任せず、構造で保証する。

## 2. レイヤ

```
  src/core/       純粋関数のみ。DOM / カメラ / File / navigator を import しない
                  gray, integral, binarize, warp, pack, crc32, png, pdf, deflate, config
        ↑
  src/ports/      境界の型定義だけ。実装を持たない
                  ImageSource(画像の供給元) / Exporter(生成物の書き出し先)
        ↑
  src/adapters/   ports の実装。ここにだけデバイス依存を置く
                  LiveCameraSource    getUserMedia + video + canvas   [実機必須]
                  FileCaptureSource   <input type="file" capture>     [実機必須]
                  FixtureImageSource  合成書類を生成                   [Node で動く]
                  ShareExporter       navigator.share({ files })      [実機必須]
                  DownloadExporter    <a download>                    [実機必須]
                  MemoryExporter      バイト列を保持するだけ            [Node で動く]
```

**依存の向きは常に下から上**。`core/` は `ports/` すら知らない。
アプリ本体だけが adapters を選んで組み立てる。

## 3. 実機なしで何がテストできて、何ができないか

正直に線を引く。

| 対象 | 実機なしで検証できるか | 方法 |
|---|---|---|
| グレースケール化・積分画像 | ✅ | 単体テスト |
| 適応二値化(Sauvola / Bradley) | ✅ | 合成書類の正解と比較 |
| 射影変換(homography / warp) | ✅ | 既知の四隅で往復・一致率 |
| 1bit パッキング・PNG・PDF | ✅ | 構造検証 + inflate 往復 |
| パイプライン全体の結合 | ✅ | `FixtureImageSource` → `MemoryExporter` |
| **getUserMedia の実解像度** | ❌ | M0.5 の probe が実測する |
| **standalone でのカメラ権限挙動(L-4)** | ❌ | 同上 |
| **`navigator.share({files})` の成否** | ❌ | 同上 |
| **実機での処理時間(NFR-01)** | ❌ | 同上 |
| **シャッター音が鳴らないこと** | ❌ | 同上。人間が耳で確認するしかない |
| **実書類での二値化品質** | ❌ | 合成画像は近似にすぎない |

つまり **「アルゴリズムの正しさ」は実機なしで確定でき、「プラットフォームの実力」と
「実写での画質」は実機でしか分からない。** この分割が M0.5 を必須にしている理由。

## 4. 合成書類フィクスチャ

`src/test/fixtures/synthetic.ts` が「机の上の書類を斜めから撮った写真」を生成する。

- 理想の紙面(正解の二値画像)を作る
- それを指定の四隅へ射影変換して写真座標に置く
- 左上→右下の照明ムラ(影)を掛ける
- 決定的な擬似乱数でノイズを乗せる(`Math.random` は使わない。再現性のため)

正解が既知なので、**二値化が影に負けていないかを数値で判定できる**。
実写より条件を厳しく振れるので、回帰テストとしては実写より有用。

### 一致率の測り方に注意

リサンプリングを挟むと、ストロークの輪郭 1px は必ず中間値になり、
どのアルゴリズムでも 0/1 のどちらに倒れるか決まらない。
このため一致率には 2 種類を用意している。

- `agreement` — 素の一致率。**解像度不足の影響を見る**のに使う
- `agreementIgnoringEdges` — 正解側のエッジ近傍を除外。**幾何の正しさを見る**のに使う

幾何のテストに素の一致率を使うと、本質的でない輪郭差でしきい値が決まってしまう。

## 5. テスト実行系

`node --test --experimental-strip-types src/test/*.test.ts`。
Node 24 の型ストリッピングで TypeScript を直接実行するため、
**テストランナーの依存はゼロ**(vite と typescript はビルド用のみ)。

制約: 型ストリッピングは消去だけで変換をしないため、
`enum` / `namespace` / コンストラクタのパラメータプロパティ(`constructor(private x)`)は使えない。
adapters にコメントで注記してある。
