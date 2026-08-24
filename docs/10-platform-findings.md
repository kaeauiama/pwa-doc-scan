# プラットフォーム調査結果(PWA / WebKit)

調査日: 2026-08-24 / 状態: **机上調査のみ。実測は M0.5 で行い、この文書を更新する。**

`00-scope-and-constraints.md` と矛盾する場合はそちらが正。

---

## 1. 既存アプリの状況

**Microsoft Lens は 2026-01-09 にストアから撤去、2026-02-09 でサポート終了、
2026-03-09 でスキャン機能停止。** 後継として案内されている OneDrive のスキャンは
モード 1 種のみ・編集機能が限定・**ローカル保存不可**。
「シンプルな書類スキャナ」に空席がある。

主要アプリ(Adobe Scan / Genius Scan / vFlat)から抽出した実質必須の機能:

- 自動輪郭検出 + オートキャプチャ ← 体験の核
- 透視補正
- 影除去 / 適応二値化 ← モノクロ品質はここで決まる
- 白黒 / グレー / カラー切替
- 複数ページ → 1 PDF

**OCR は 3 社とも有料ライン。** それ以外は無料圏。
差別化しうるのは「無音」「オフライン完結・無課金・透かし無し」「出力サイズの細かい制御」。

## 2. 解像度(最重要・L-1)

| 経路 | 解像度 | A4 を画面いっぱいに撮った時の実効 DPI | 音 |
|---|---|---|---|
| `getUserMedia` 1080p | 1920×1080 | 約 130 dpi | 無音 |
| `getUserMedia` 4K(取得可なら) | 3840×2160 | 約 260 dpi | 無音 |
| `<input type="file" capture>` | 4032×3024 (12MP) | 約 365 dpi | **あり** |
| native アプリ | 12MP+ | 365 dpi | あり(日本版) |

DPI は A4 短辺 210mm / 長辺 297mm に対する概算。縦持ちで短辺いっぱいに写した場合。

**iPhone Safari の `getUserMedia` で実際に 4K が取れるかは端末依存で未確認。**
ここが M0.5 の最優先計測項目。130dpi なら D-002 の高画質モードが主役になり、
260dpi なら無音モードで足りる。

## 3. WebKit の制約

| 項目 | 状況 |
|---|---|
| `ImageCapture`(takePhoto / grabFrame) | **Safari 未対応**(macOS / iOS とも)。iOS 上の Chrome 等も WKWebView なので同じ |
| torch(ライト)制御 | iPhone のカメラは `getCapabilities()` に torch を出さないのが通例。Android の一部で可 |
| フォーカス / 露出のマニュアル制御 | iOS 不可 |
| standalone PWA でのカメラ | 動作するが、**権限が毎回聞かれる / 黒画面になる**不具合報告が継続している。緩和策は iOS 更新・端末再起動・Safari タブで開く |
| ストレージ 7 日削除 | Safari のタブで開いた場合は対象。**ホーム画面に追加した web app は Safari とは別枠で、独自の使用日数カウンタを持つため対象外** |
| Web Share API Level 2(ファイル共有) | Safari 17 以降で利用可。**iOS で最も確実な書き出し経路** |
| Web Share **Target**(共有先になる) | Android / Chrome のみ。iOS 非対応 |
| `<a download>` in standalone | iOS 13 以降おおむね動くが不安定との報告が残る。副動線として持ち、失敗を検出したら共有シートへ誘導する |
| File System Access API | iOS 非対応 |
| EU 圏の iOS | DMA 対応により standalone PWA が Safari タブで開く場合がある |

## 4. 出力形式とサイズ(概算・要実測)

A4 相当 1 ページ。

| 出力 | 見込みサイズ | 評価 |
|---|---|---|
| JPEG グレー q0.7 | 300〜600 KB | 二値画像に JPEG は不適(輪郭にリンギング) |
| PNG(canvas 既定 = 8bit RGBA) | 300 KB〜1 MB | 無駄が大きい |
| **1bit PNG(自前エンコード)** | **30〜80 KB** | ビットパック + `CompressionStream('deflate')` |
| **1bit 画像を埋めた PDF(FlateDecode)** | **20〜60 KB** | ← 採用(D-004) |

`CompressionStream('deflate')` は **zlib(RFC 1950)ラップ付き**で出力されるため、
PNG の IDAT にも PDF の FlateDecode にもそのまま入る。
自前実装が必要なのは CRC32 テーブル(PNG のみ)と最小 PDF ライタだけ。

CCITT Group 4 は PDF の標準フィルタだが、書類画像では Flate との差は大きくなく、
エンコーダの実装コストに見合わないため**採用しない**。

### 4.1 エンコーダの検証(2026-08-24 実施)

`probe/index.html` の `encodePng1bit` / `encodePdf1bit` を Node で切り出して検証済み。

- PNG: シグネチャ・IHDR(1240x1754, bitDepth=1, colorType=0)・全チャンクの CRC32 を照合。
  IDAT を inflate して `(rowBytes+1)*h` 一致、全ピクセルのビット往復一致(不一致 0)。
- PDF: xref の全オフセットが実際の `N 0 obj` 位置を指すこと、`startxref` が `xref` を指すこと、
  画像・コンテンツ両ストリームの `/Length` が実バイト数と一致することを照合。
  さらに **pypdf でパースし、1 ページ / MediaBox A4(595.2x841.92pt) /
  埋め込み画像 mode='1' 1240x1754 を取り出して元ビットと一致することを確認**。

**注意: このときのサイズ(PNG 1.8KB / PDF 1.6KB)は合成の規則パターンなので参考にならない。**
実書類での実測は M0.5 で行う(probe の §4 が測る)。

## 5. M0.5 で計測すること

`probe/index.html` が測る項目:

1. `getUserMedia` の解像度ラダー(720p / 1080p / 1440p / 4K / ideal 最大)での実取得値
2. `track.getCapabilities()` の全ダンプ(torch / focusMode / zoom の有無)
3. `<input type="file" capture>` が実際に返す静止画の解像度とバイト数
4. API 有無: OffscreenCanvas / createImageBitmap / CompressionStream / WebGL2 /
   WebAssembly SIMD / `navigator.canShare({files})` / OPFS / `storage.persist()`
5. **1bit PNG と 1bit PDF を実機で生成し、所要時間とバイト数を実測**
6. `navigator.share({files})` で生成 PDF を実際に書き出せるか
7. standalone 判定・secure context・UA

## 6. 出典

- Microsoft Lens 提供終了 — https://support.microsoft.com/en-us/lens/retirement-of-microsoft-lens
- WebKit ストレージポリシー(7 日削除とホーム画面 web app の扱い) — https://webkit.org/blog/14403/updates-to-storage-policy/
- iOS PWA でのカメラアクセス不具合 — https://kb.strich.io/article/29-camera-access-issues-in-ios-pwa
- ImageCapture のブラウザ対応 — https://www.testmuai.com/learning-hub/image-capture-api-browser-support/
- MediaStreamTrack の capabilities と torch — https://oberhofer.co/mediastreamtrack-and-its-capabilities/
- PWA on iOS の制約まとめ — https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide
