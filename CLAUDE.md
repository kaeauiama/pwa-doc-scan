# pwa-doc-scan

書類スキャン特化の PWA カメラアプリ。撮影 → 輪郭検出 → 透視補正 → モノクロ二値化 →
1bit PDF 書き出し までを **完全に端末内で** 完結させる。

## このリポジトリの正典

| 文書 | 役割 | 優先度 |
|---|---|---|
| `docs/00-scope-and-constraints.md` | 要件(REQ/NFR)・非目標・Hard Constraints | **正**(矛盾時はこれが勝つ) |
| `docs/10-platform-findings.md` | PWA/WebKit のプラットフォーム制約の調査結果 | 参考(実測で更新する) |
| `docs/decision-log.md` | 意思決定の記録(D-001…) | **正**(決定の履歴) |
| `docs/20-architecture.md` | レイヤ構成とデバイス境界の切り方 | 参考 |
| `public/probe/index.html` | M0.5 実機能力計測ページ | ツール |

数値の閾値・定数は **コード側の単一箇所(`src/config.ts` 予定)を正**とする。
ドキュメントには数値を直書きせず、名前で参照する。

## 絶対に越えない一線(詳細は 00-scope の HC-1〜HC-4)

1. 用途は書類・紙面のスキャン。人物撮影向けの機能・訴求はしない。
2. 隠し撮りを容易にする機能は恒久的に非対応(黒画面撮影・UI偽装・音量ボタン連写・
   バックグラウンド撮影)。技術的に可能でも実装しない。
3. 画像・その派生物を端末外に送信しない。アップロード動線・解析APIを一切持たない。
4. 非対応は理由コードで明示する。沈黙の失敗や回避的ハックで通さない。

## 開発

```
npm run dev        # ローカル開発サーバ
npm test           # node --test。ランナー依存ゼロ、実機不要
npm run typecheck  # tsc --noEmit
npm run build      # dist/ を生成(GitHub Pages が使う)
```

`main` に push すると Actions がテスト → ビルド → GitHub Pages へデプロイする。

コードは 3 層。`src/core/` は純粋関数のみで DOM / カメラを import しない。
デバイス依存は `src/adapters/` にだけ置く。詳細は `docs/20-architecture.md`。

## 現在地

**M0 / M0.5 完了。M1 実装完了(実機での確認待ち)。テスト 41 件通過。**

実機計測で机上の前提が覆った(D-017 / D-025)。`getUserMedia` は **4032x3024 /
12.2MP / A4 実効 366dpi** を **30fps・発熱なし**で返し、**`torch` も制御できる**。
このため撮影経路は無音の 1 本に統合し(D-020)、解像度の切り替えもしない(D-025)。

- コア: 照明の平坦化、Sobel、Hough、**四隅の自動検出 + 高解像度での精密化**、
  適応二値化、射影変換(グレー / カラー)、背景の白飛ばし、
  1bit PNG、**PDF(1bit + FlateDecode / JPEG + DCTDecode の複数ページ)**
- パイプライン: `src/pipeline.ts` の `scanToPage`。
  **カラー / グレースケール / 白黒2値**の 3 モード(REQ-20)
- アダプタ: `LiveCameraSource` / `FileImportSource` / `CanvasJpegEncoder` /
  `ShareExporter` / `DownloadExporter`
- UI: `src/ui/`。ホーム / 撮影 / 四隅調整 / 結果 / 診断 の 5 画面。
  ライブ輪郭オーバーレイ、四隅のドラッグ調整、モード・DPI 切替、torch、
  共有シートとダウンロード、理由コード付きの失敗表示
- オフライン動作: `public/sw.js`(キャッシュ優先 + 裏で更新)

**既知の限界**: カラーの帯がある原稿(チラシ等)は輪郭検出が半分ほど外す。
2 案試して両方失敗し revert した(D-028)。REQ-03 の手動調整で受ける前提なので、
**検出結果は必ず編集可能なオーバーレイとして出すこと。**

公開先: https://kaeauiama.github.io/pwa-doc-scan/ (probe は `/probe/`)

次のアクション: **実機で M1 を一通り試す**。特に (1) 12.2MP でのライブ輪郭検出が
実用的な速さで動くか、(2) 撮影から PDF までの実処理時間(NFR-01: 3 秒以内)、
(3) 共有シートでの保存、(4) 機内モードでの起動(REQ-13)。
