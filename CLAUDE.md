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

**M0 完了 / M0.5 は Safari タブで実施済み(standalone は未実施)。
コア(`src/core/`)は先行実装済み・テスト 23 件通過。**

実機計測で前提が 2 つ覆った(D-017)。`getUserMedia` は **4032x3024 / 12.2MP /
A4 実効 366dpi** を返し、**`torch` も制御できる**。静止画経路と解像度が同一のため、
D-002 の「2 経路併存」の存在理由が消えている(U-09 として再判断待ち)。

- 実装済み: グレースケール、積分画像、照明の平坦化、Sobel、Hough 直線変換、
  **書類の四隅の自動検出 + 高解像度での精密化**、適応二値化(Sauvola / Bradley)、
  射影変換、1bit パッキング、PNG エンコーダ、複数ページ PDF エンコーダ
- 未実装: 撮影 UI、実機アダプタ
  (`LiveCameraSource` / `FileCaptureSource` / `ShareExporter` / `DownloadExporter`)

公開先: https://kaeauiama.github.io/pwa-doc-scan/ (probe は `/probe/`)

次のアクション:
1. U-09 を決める(2 経路を維持するか / プレビュー解像度をどうするか)
2. standalone(ホーム画面起動)で probe を再実施し L-4 を確認する
3. M1 の撮影 UI と実機アダプタを実装する
