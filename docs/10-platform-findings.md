# プラットフォーム調査結果(PWA / WebKit)

机上調査: 2026-08-24 / **実機計測: 2026-08-24(iPhone / iOS 18.7 / Safari 26.6 / Safari タブ)**

`00-scope-and-constraints.md` と矛盾する場合はそちらが正。

> **状態: 実測により §2 と §3 を全面改訂した。**
> 机上調査で立てた L-1(フル解像度が撮れない)と L-2(torch 不可)は、
> この端末では**成立しなかった**。以下は実測値を正とする。
> ただし計測は 1 端末・Safari タブでの 1 回のみ。standalone(ホーム画面起動)は未計測。

---

## 1. 既存アプリの状況

**Microsoft Lens は 2026-01-09 にストアから撤去、2026-02-09 でサポート終了、
2026-03-09 でスキャン機能停止。** 後継として案内されている OneDrive のスキャンは
モード 1 種のみ・編集機能が限定・**ローカル保存不可**。
「シンプルな書類スキャナ」に空席がある。

主要アプリ(Adobe Scan / Genius Scan / vFlat)から抽出した実質必須の機能:
自動輪郭検出 + オートキャプチャ / 透視補正 / 影除去・適応二値化 /
白黒・グレー・カラー切替 / 複数ページ → 1 PDF。**OCR は 3 社とも有料ライン。**

## 2. 解像度(実測 — L-1 は覆った)

`getUserMedia` の解像度ラダー(背面デュアル広角カメラ):

| 要求 | 実取得 | 画素数 | fps | A4 短辺換算 |
|---|---|---|---|---|
| 1280x720 | 1280x720 | 0.9MP | 30 | 87 dpi |
| 1920x1080 | 1920x1080 | 2.1MP | 30 | 131 dpi |
| 2560x1440 | 2560x1440 | 3.7MP | 30 | 174 dpi |
| 3840x2160 | 3840x2160 | 8.3MP | 30 | 261 dpi |
| **99999x99999(最大要求)** | **4032x3024** | **12.2MP** | 30 | **366 dpi** |

`<input type="file" capture>` が返した静止画も **3024x4032 / 12.2MP / 366dpi**(JPEG 3.50MB)。

**つまり `getUserMedia` はセンサーのフル解像度をそのまま出す。
静止画経路と解像度が完全に同一で、PWA が解像度でネイティブに劣る点は無かった。**

`getCapabilities().width.max = 4032` / `height.max = 3024` もこれを裏づけている。

影響:
- **L-1 は取り下げ。** 「PWA はフル解像度の静止画が撮れない」は少なくともこの端末では誤り
- D-002(無音モードと高画質モードの 2 経路併存)の前提が消えた。**再判断が必要**(U-09)
- A4 を画面いっぱいに撮れば 366dpi。300dpi 出力でも情報が足りる

## 3. カメラの capabilities(実測 — L-2 も覆った)

背面デュアル広角カメラの `getCapabilities()`:

| 項目 | 値 | 評価 |
|---|---|---|
| `torch` | **true** | **ライトを制御できる。L-2 は取り下げ**(U-10) |
| `zoom` | 0.5 〜 10 | 使える |
| `whiteBalanceMode` | `["manual", "continuous"]` | 手動指定が可能 |
| `focusDistance` | `{ min: 0.12 }` | max が無く、意味のある制御ができるかは不明 |
| `frameRate` | 1 〜 60 | |
| `width` / `height` | 最大 4032 / 3024 | §2 のとおり |
| `backgroundBlur` | `[false]` | 不可(不要) |

利用可能なカメラは 4 つ:前面 / 背面デュアル広角 / 背面超広角 / 背面。
**書類には背面デュアル広角(既定)が適切。超広角は歪みが大きいので選ばない。**

`facingMode: { ideal: "environment" }` で背面デュアル広角が選ばれた。

## 4. API サポート(実測)

| 項目 | 結果 | 備考 |
|---|---|---|
| `getUserMedia` | ✅ | |
| `OffscreenCanvas` / `createImageBitmap` | ✅ | Worker 化が可能 |
| `CompressionStream("deflate")` | ✅ | **PDF 生成の前提が実機で確認できた** |
| `WebGL2` | ✅ | 射影変換を GPU に載せられる(U-07) |
| `navigator.share` / `canShare({files})` | ✅ | |
| **実際に PDF を共有シートへ書き出し** | ✅ **成功** | **D-005 の主動線が実機で成立** |
| OPFS / `storage.persist` | ✅ | |
| ストレージ容量上限 | **約 38 GB** | 想定よりはるかに潤沢 |
| `Service Worker` | ✅ | |
| `toBlob("image/jpeg")` | ✅ | |
| `toBlob("image/webp")` | ❌ | WebP エンコード不可。PDF 方針なので影響なし |
| `showSaveFilePicker` | ❌ | L-6 のとおり。共有シート一本で正しい |
| `ImageCapture` | 定義は存在する | **`takePhoto()` が動くかは未検証。§7 参照** |
| `WebAssembly SIMD` | **計測失敗** | probe の判定バイト列が不正だった(修正済み・再計測要) |

## 5. 処理性能(実測 / 12.2MP の全画面に対して)

| 段階 | getUserMedia 経路 | 静止画(JPEG)経路 |
|---|---|---|
| 取り込み + `getImageData` | 341 ms | 133 ms |
| グレースケール | 63 ms | 14 ms |
| 適応二値化 | 135 ms | 102 ms |
| 1bit PNG エンコード | 221 ms | 71 ms |
| 1bit PDF エンコード | 69 ms | 74 ms |
| **合計** | **829 ms** | **394 ms** |

**NFR-01(1 ページ 3 秒以内)に対して十分な余裕がある。**
ただしこの計測には輪郭検出と透視補正が含まれていない。M1 で再計測すること。

## 6. 出力サイズ

probe が出した PDF は 271 KB / 354 KB だが、これは
**12.2MP の写真全体(机の背景込み)を縮小せずに二値化した値**であり、実運用の値ではない。

実際のパイプラインでは透視補正で A4 の目標 DPI に正規化してから二値化する。
合成書類(黒画素率 20%、実際の文書より重い)での実測:

| 出力 | ノイズ小 | ノイズ大 |
|---|---|---|
| A4 150dpi (1240x1754) | 28 KB | 34 KB |
| **A4 200dpi (1654x2339)** | **43 KB** | **51 KB** |
| A4 300dpi (2480x3508) | 75 KB | 118 KB |

**200dpi なら NFR-03(100KB 以内)を確実に満たす。** 300dpi はノイズが多いと超えうる。

Sauvola と Bradley の差はノイズが少なければほぼ無い。ノイズが大きいと Sauvola が
1〜2 割小さくなる(200dpi / ノイズ大で 62KB → 51KB)。

CCITT Group 4 は PDF の標準フィルタだが、Flate との差は実装コストに見合わないため採用しない。

## 7. 残る制約と未検証項目

**追記(2026-08-25)**: `navigator.share({files, title})` のように files と文字列を
一緒に渡すと、iOS では文字列が別の共有アイテムになり、「ファイルに保存」で
.txt が余分に書き出される。**files のみを渡すこと**(D-038)。

| ID | 制約 | 状態 |
|---|---|---|
| ~~L-1~~ | ~~フル解像度の静止画が撮れない~~ | **取り下げ(§2)** |
| ~~L-2~~ | ~~torch 制御が不可~~ | **取り下げ(§3)** |
| L-3 | マニュアルフォーカス / 露出の制御 | `focusDistance` は min のみ。実質使えるかは未検証 |
| **L-4** | **standalone でカメラ権限が毎回聞かれる / 黒画面** | **未計測。ホーム画面に追加して要再実施** |
| L-5 | Web Share Target は Android のみ | 変更なし(iOS では「共有先」になれない) |
| L-6 | File System Access API が iOS に無い | 実測で確認(`showSaveFilePicker` = false) |
| L-7 | 端末内 OCR の現実的手段が乏しい | 変更なし(NG-01) |
| L-8 | iOS はインストールプロンプトが無い | 変更なし |
| L-9 | EU 圏の iOS は Safari タブで開く場合がある | 変更なし |
| **L-10** | **`ImageCapture.takePhoto()` はシャッター音を鳴らす可能性がある** | **未検証。`getUserMedia` で 12.2MP が取れる以上、使う理由が無いので使わない** |
| **L-11** | **12.2MP / 30fps のストリームを流し続けたときの発熱・電池・実 fps** | **未計測(U-09)** |

### 未計測で、次に測るべきもの

1. **standalone(ホーム画面起動)での全項目**(L-4)
2. **`getUserMedia` 経路で本当に無音か**、および静止画経路で音が鳴るか(人間の耳でのみ確認可能)
3. WebAssembly SIMD(probe 修正済み)
4. 12.2MP ストリームの実 fps と発熱
5. 輪郭検出 + 透視補正を含めた実処理時間

## 8. 出典(机上調査分)

- Microsoft Lens 提供終了 — https://support.microsoft.com/en-us/lens/retirement-of-microsoft-lens
- WebKit ストレージポリシー — https://webkit.org/blog/14403/updates-to-storage-policy/
- iOS PWA でのカメラアクセス不具合 — https://kb.strich.io/article/29-camera-access-issues-in-ios-pwa
- ImageCapture のブラウザ対応 — https://www.testmuai.com/learning-hub/image-capture-api-browser-support/
- MediaStreamTrack の capabilities と torch — https://oberhofer.co/mediastreamtrack-and-its-capabilities/

**注: 上記の出典のうち ImageCapture と torch に関する記述は、本計測と食い違う。
2026 年 8 月時点の実機を正とする。**
