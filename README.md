# pwa-doc-scan

紙の書類をスマートフォンで撮影し、読みやすいモノクロで、適切なファイルサイズの PDF として
保存する PWA。撮影・画像処理・PDF 生成をすべてブラウザ内で完結させる。

**開発中(M0.5)。撮影 UI はまだありません。**

## 何をするか

撮影 → 書類の四隅を検出 → 透視補正 → 局所適応二値化 → 1bit PDF 書き出し。
出力は 1bit 画像を FlateDecode で埋めた PDF で、外部ライブラリを使わず自前で生成する。

## 用途と、やらないこと

このツールの用途は **紙の書類・紙面のスキャン**に限定する。

- 人物撮影向けの機能や訴求は持たない
- 隠し撮りを容易にする機能は恒久的に非対応
  (黒画面/画面オフ撮影、UI 偽装、音量ボタンでの撮影、バックグラウンド撮影、タイマー連写)。
  技術的に可能でも実装しない
- 画像およびその派生物を端末外に送信しない。アップロード動線も外部解析 API も持たない

`getUserMedia` によるフレーム取得は OS の静止画撮影パスを通らないため撮影音が鳴らないが、
これは PWA という選択の副次的な性質であって、このツールの目的ではない。
上記の制約は [docs/00-scope-and-constraints.md](docs/00-scope-and-constraints.md) の
Hard Constraints として固定し、ガードと回帰テストで担保する。

## PWA としての限界

ネイティブアプリに対して劣る点を隠さない。詳細は
[docs/10-platform-findings.md](docs/10-platform-findings.md)。

- フル解像度の静止画が撮れない(`getUserMedia` は動画フレームのみ)
- iOS はライト(torch)制御・マニュアルフォーカス/露出が使えない
- iOS では「共有先」になれない(Web Share Target 非対応)
- 指定フォルダへの自動保存ができない(File System Access API 非対応)
- OCR は非目標

## 構成

```
src/core/      純粋関数のみ。DOM / カメラを import しない
src/ports/     デバイス境界の型定義(ImageSource / Exporter)
src/adapters/  ports の実装。デバイス依存はここにだけ置く
public/probe/  実機能力計測ページ(getUserMedia の実解像度などを測る)
docs/          スコープ・制約・調査結果・アーキテクチャ・Decision Log
```

`src/core/` は Node でそのまま動くため、実機なしでアルゴリズムを検証できる。
何が検証できて何ができないかは [docs/20-architecture.md](docs/20-architecture.md) §3 に明示。

## 開発

```
npm install
npm test           # node --test。テストランナー依存ゼロ、実機不要
npm run typecheck
npm run dev
npm run build
```

`main` への push で GitHub Actions がテスト → ビルド → GitHub Pages へデプロイする。

## ライセンス

未定。
