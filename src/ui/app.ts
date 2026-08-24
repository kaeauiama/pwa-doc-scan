import { detectDocumentQuad } from "../core/detect.ts";
import { rgbaToGray } from "../core/gray.ts";
import { encodeOutput, fullFrameQuad, scanToPage } from "../pipeline.ts";
import { PageCollection } from "../pages.ts";
import { LiveCameraSource } from "../adapters/LiveCameraSource.ts";
import { FileImportSource } from "../adapters/FileImportSource.ts";
import { CanvasJpegEncoder } from "../adapters/CanvasJpegEncoder.ts";
import { DownloadExporter, ShareExporter, exportWithFallback } from "../adapters/WebExporters.ts";
import { SourceError } from "../ports/ImageSource.ts";
import { CornerEditor } from "./CornerEditor.ts";
import { bilevelToCanvas, containFit, drawQuad, rgbaToCanvas } from "./render.ts";
import { clampQuad } from "../core/warp.ts";
import { collectEnvironment, getFailures, isStandalone, recordFailure } from "./diagnostics.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import type { OutputFormat, RenderMode, ScanResult } from "../pipeline.ts";
import type { SharpnessVerdict } from "../core/sharpness.ts";
import type { BinarizeMethod } from "../core/binarize.ts";
import type { Quad, Rgba } from "../core/types.ts";

/* ---------------- 要素 ---------------- */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`要素が見つかりません: ${id}`);
  return el as T;
};

const views = {
  home: $("view-home"),
  capture: $("view-capture"),
  adjust: $("view-adjust"),
  result: $("view-result"),
  pages: $("view-pages"),
  diag: $("view-diag"),
};
type ViewName = keyof typeof views;

const preview = $<HTMLVideoElement>("preview");
const overlay = $<HTMLCanvasElement>("overlay");
const editorCanvas = $<HTMLCanvasElement>("editor");
const resultCanvas = $<HTMLCanvasElement>("result");
const detectBadge = $("detect-badge");
const toast = $("toast");
const busy = $("busy");
const busyLabel = $("busy-label");

/* ---------------- 状態 ---------------- */

/** 表示用に縮小した画像の長辺。12.2MP を毎回描き直すのは重いため */
const DISPLAY_LONG_EDGE = 1400;
/** ライブ検出に使うフレームの長辺 */
const LIVE_LONG_EDGE = 480;

const jpegEncoder = new CanvasJpegEncoder();
const exporters = [new ShareExporter(), new DownloadExporter()];

let camera: LiveCameraSource | null = null;
let editor: CornerEditor | null = null;
let liveTimer = 0;
let liveQuad: Quad | null = null;

/** 撮影した元画像(フル解像度)。処理はこれに対して行う */
let captured: Rgba | null = null;
/** 表示用に縮小した canvas */
let displayCanvas: HTMLCanvasElement | null = null;
/** 元画像 → 表示画像 の倍率 */
let displayScale = 1;
let detectedQuad: Quad | null = null;

const settings = loadSettings();
let mode: RenderMode = settings.mode;
let format: OutputFormat = settings.format;
let dpi: number = settings.dpi;
let whiten: boolean = settings.whiten;
let binarizeStrength: number = settings.binarizeStrength;
let binarizeMethod: BinarizeMethod = settings.binarizeMethod;

/** 選択を端末に覚えておく。画像は一切置かない(HC-3) */
function persist(): void {
  saveSettings({ mode, format, dpi, whiten, binarizeStrength, binarizeMethod });
}
let lastOutput: { bytes: Uint8Array; mimeType: string; extension: string } | null = null;
let lastScan: ScanResult | null = null;

/**
 * 撮り溜めたページ(REQ-10)。端末には保存せず、メモリ上だけで束ねる。
 * サムネイルは表示専用なので PageCollection には持たせず、ここで別に持つ。
 */
const pages = new PageCollection();
const thumbnails = new Map<string, string>();
/** ページごとのブレ判定。表示のためだけなので PageCollection には持たせない */
const pageSharpness = new Map<string, SharpnessVerdict>();

/* ---------------- 小物 ---------------- */

let toastTimer = 0;
function say(message: string, code?: string): void {
  toast.innerHTML = "";
  toast.append(document.createTextNode(message));
  if (code) {
    toast.append(document.createElement("br"));
    const el = document.createElement("code");
    el.textContent = code;
    toast.append(el);
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, code ? 6000 : 3000);
}

function setBusy(on: boolean, label = "処理中…"): void {
  busyLabel.textContent = label;
  busy.hidden = !on;
}

/** 重い同期処理の前に一度描画を通し、スピナーを確実に出す */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function show(name: ViewName): void {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  if (name !== "capture") stopLiveDetection();
}

function fillTable(table: HTMLTableElement, rows: Record<string, string | boolean | number>): void {
  table.innerHTML = "";
  for (const [key, value] of Object.entries(rows)) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = key;
    const td = document.createElement("td");
    if (value === true) {
      td.textContent = "利用可";
      td.className = "ok";
    } else if (value === false) {
      td.textContent = "利用不可";
      td.className = "ng";
    } else {
      td.textContent = String(value);
    }
    tr.append(th, td);
    table.append(tr);
  }
}

function describe(err: unknown): { code: string; message: string } {
  if (err instanceof SourceError) {
    const messages: Record<string, string> = {
      UNSUPPORTED_INSECURE_CONTEXT: "HTTPS でないとカメラを使えません。",
      UNSUPPORTED_NO_GETUSERMEDIA: "このブラウザはカメラに対応していません。",
      PERMISSION_DENIED: "カメラの使用が許可されませんでした。",
      NO_CAMERA: "カメラが見つかりません。",
      CAMERA_BUSY: "カメラを他のアプリが使用中です。",
      UNSUPPORTED_CONSTRAINTS: "この端末では要求した解像度を使えません。",
      NOT_STARTED: "カメラの準備ができていません。",
      DECODE_FAILED: "この画像を読み込めませんでした。",
      FAILED_UNKNOWN: "原因不明の失敗です。",
    };
    return { code: err.reason, message: messages[err.reason] ?? "失敗しました。" };
  }
  return {
    code: "FAILED_UNKNOWN",
    message: err instanceof Error ? err.message : String(err),
  };
}

function fail(where: string, err: unknown): void {
  const { code, message } = describe(err);
  recordFailure(where, code, err instanceof Error ? err.message : undefined);
  say(message, code);
}

/* ---------------- ライブ検出(REQ-02) ---------------- */

const liveCanvas = document.createElement("canvas");

function stopLiveDetection(): void {
  clearTimeout(liveTimer);
  liveTimer = 0;
}

function drawOverlay(): void {
  const ctx = overlay.getContext("2d");
  if (!ctx) return;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const w = overlay.clientWidth * ratio;
  const h = overlay.clientHeight * ratio;
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w;
    overlay.height = h;
  }
  ctx.clearRect(0, 0, w, h);
  if (!liveQuad || !preview.videoWidth) return;
  const fit = containFit(preview.videoWidth, preview.videoHeight, w, h);
  drawQuad(ctx, liveQuad, fit, { stroke: "#22c55e", fill: "rgba(34,197,94,0.12)", lineWidth: 2 * ratio });
}

function runLiveDetection(): void {
  if (!camera || views.capture.hidden) return;
  try {
    const vw = preview.videoWidth;
    const vh = preview.videoHeight;
    if (vw > 0 && vh > 0) {
      const scale = LIVE_LONG_EDGE / Math.max(vw, vh);
      liveCanvas.width = Math.max(1, Math.round(vw * scale));
      liveCanvas.height = Math.max(1, Math.round(vh * scale));
      const ctx = liveCanvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(preview, 0, 0, liveCanvas.width, liveCanvas.height);
        const frame = ctx.getImageData(0, 0, liveCanvas.width, liveCanvas.height);
        const result = detectDocumentQuad(
          rgbaToGray({ width: liveCanvas.width, height: liveCanvas.height, data: frame.data }),
          { refine: false },
        );
        if (result.ok) {
          const inv = 1 / (liveCanvas.width / vw);
          liveQuad = result.quad.map((p) => ({ x: p.x * inv, y: p.y * inv })) as unknown as Quad;
          detectBadge.textContent = `枠を検出 ${(result.confidence * 100).toFixed(0)}%`;
        } else {
          liveQuad = null;
          detectBadge.textContent = "枠を探しています…";
        }
        drawOverlay();
      }
    }
  } catch {
    // ライブ検出の失敗は撮影を妨げない。記録もしない(毎フレーム出るため)
  }
  liveTimer = window.setTimeout(runLiveDetection, 150);
}

/* ---------------- 撮影 ---------------- */

async function startCamera(): Promise<boolean> {
  camera = new LiveCameraSource({ video: preview });
  try {
    await camera.start();
  } catch (err) {
    camera = null;
    fail("カメラ開始", err);
    return false;
  }
  show("capture");
  $("btn-torch").hidden = !camera.isTorchAvailable();
  liveQuad = null;
  detectBadge.textContent = "枠を探しています…";
  runLiveDetection();
  return true;
}

function stopCamera(): void {
  stopLiveDetection();
  camera?.stop();
  camera = null;
}

/** 撮影した画像を四隅の調整画面に載せる */
async function goToAdjust(frame: Rgba, source: string): Promise<void> {
  captured = frame;
  setBusy(true, "書類の輪郭を探しています…");
  await nextFrame();
  try {
    const full = rgbaToCanvas(frame);
    displayScale = Math.min(1, DISPLAY_LONG_EDGE / Math.max(frame.width, frame.height));
    displayCanvas = document.createElement("canvas");
    displayCanvas.width = Math.round(frame.width * displayScale);
    displayCanvas.height = Math.round(frame.height * displayScale);
    const ctx = displayCanvas.getContext("2d");
    if (!ctx) throw new Error("2d コンテキストを取得できません");
    ctx.drawImage(full, 0, 0, displayCanvas.width, displayCanvas.height);

    const detection = detectDocumentQuad(rgbaToGray(frame));
    const note = $("adjust-note");
    if (detection.ok) {
      // 検出は画像の外側まで角を許すが、外に出るとハンドルを掴めなくなる
      detectedQuad = clampQuad(detection.quad, frame.width, frame.height);
      note.textContent = `輪郭を検出しました(確からしさ ${(detection.confidence * 100).toFixed(0)}%)。ずれていれば四隅をドラッグして直してください。`;
    } else {
      detectedQuad = fullFrameQuad(frame.width, frame.height);
      note.textContent = "輪郭を自動検出できませんでした。四隅をドラッグして書類の角に合わせてください。";
      recordFailure(source, detection.reason);
    }

    editor ??= new CornerEditor(editorCanvas);
    editor.setImage(displayCanvas, scaleQuad(detectedQuad, displayScale));
    show("adjust");
    // レイアウト確定後にもう一度サイズを合わせる
    requestAnimationFrame(() => editor?.layout());
  } catch (err) {
    fail(source, err);
  } finally {
    setBusy(false);
  }
}

function scaleQuad(quad: Quad, scale: number): Quad {
  return quad.map((p) => ({ x: p.x * scale, y: p.y * scale })) as unknown as Quad;
}

/* ---------------- 処理と保存 ---------------- */

const SHARPNESS_LABEL: Record<SharpnessVerdict, string> = {
  sharp: "良好",
  soft: "やや甘い",
  blurry: "ブレている",
  unknown: "判定できず",
};

const MODE_LABEL: Record<RenderMode, string> = {
  bilevel: "白黒2値",
  grayscale: "グレースケール",
  color: "カラー",
};


async function process(): Promise<void> {
  if (!captured || !editor) return;
  setBusy(true, "PDF を作っています…");
  await nextFrame();
  try {
    const quad = scaleQuad(editor.getQuad(), 1 / displayScale);
    const started = performance.now();
    const result = await scanToPage(
      captured,
      { mode, dpi, quad, whiten, binarizeMethod, binarizeStrength },
      jpegEncoder,
    );
    const output = await encodeOutput(result, format);
    const elapsed = Math.round(performance.now() - started);

    lastOutput = output;
    lastScan = result;

    if (result.processed.kind === "bilevel") bilevelToCanvas(result.processed.image, resultCanvas);
    else rgbaToCanvas(result.processed.image, resultCanvas);

    const sharp = result.sharpness;
    fillTable($<HTMLTableElement>("result-info"), {
      形式: output.label,
      出力: `${MODE_LABEL[result.mode]} / ${result.dpi}dpi`,
      サイズ: `${(output.bytes.length / 1024).toFixed(1)} KB`,
      画素数: `${result.outputWidth} x ${result.outputHeight}`,
      鮮明さ: `${SHARPNESS_LABEL[sharp.verdict]}(${sharp.score.toFixed(2)})`,
      処理時間: `${elapsed} ms`,
    });

    const warning = $("result-warning");
    if (sharp.verdict === "blurry") {
      warning.textContent = "ブレているか、ピントが合っていないようです。撮り直すと読みやすくなります。";
      warning.hidden = false;
    } else if (sharp.verdict === "soft") {
      warning.textContent = "少し甘い写りです。文字が細かい書類なら撮り直しをおすすめします。";
      warning.hidden = false;
    } else {
      warning.hidden = true;
    }
    show("result");
  } catch (err) {
    fail("PDF 作成", err);
  } finally {
    setBusy(false);
  }
}

function filename(extension: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `scan-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${extension}`;
}

async function save(onlyDownload: boolean): Promise<void> {
  if (!lastOutput) return;
  await exportBytes(lastOutput.bytes, lastOutput.mimeType, lastOutput.extension, onlyDownload);
}

async function exportBytes(
  bytes: Uint8Array,
  mimeType: string,
  extension: string,
  onlyDownload: boolean,
): Promise<boolean> {
  const payload = { bytes, filename: filename(extension), mimeType };
  const chosen = onlyDownload ? [exporters[1]] : exporters;
  const result = await exportWithFallback(payload, chosen);
  if (result.ok) {
    say(result.exporterId === "download" ? "ダウンロードしました。" : "書き出しました。");
    return true;
  }
  if (result.reason === "CANCELLED_BY_USER") return false;
  recordFailure("保存", result.reason, result.detail);
  const messages: Record<string, string> = {
    UNSUPPORTED_NO_SHARE_FILES: "この端末では共有シートにファイルを渡せません。ダウンロードをお試しください。",
    UNSUPPORTED_NO_DOWNLOAD: "この端末ではダウンロードできません。",
    FAILED_UNKNOWN: "保存に失敗しました。",
  };
  say(messages[result.reason] ?? "保存に失敗しました。", result.reason);
  return false;
}

/* ---------------- 撮り溜め(REQ-10) ---------------- */

function refreshPagesBadge(): void {
  const button = $("nav-pages");
  button.hidden = pages.size === 0;
  $("pages-count").textContent = String(pages.size);
}

/** 結果画面の canvas から一覧用の小さな画像を作る */
function makeThumbnail(): string {
  const thumb = document.createElement("canvas");
  const scale = Math.min(108 / resultCanvas.width, 144 / resultCanvas.height);
  thumb.width = Math.max(1, Math.round(resultCanvas.width * scale));
  thumb.height = Math.max(1, Math.round(resultCanvas.height * scale));
  const ctx = thumb.getContext("2d");
  if (ctx) ctx.drawImage(resultCanvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL("image/png");
}

function renderPageList(): void {
  const list = $("page-list");
  list.innerHTML = "";
  const items = pages.list();

  $("pages-summary").textContent =
    items.length === 0
      ? "まだページがありません。"
      : `${items.length} ページ / 保持しているデータは約 ${(pages.byteSize / 1024).toFixed(0)} KB です。`;
  $<HTMLButtonElement>("btn-pages-save").disabled = items.length === 0;

  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "結果の画面から「ページに追加して続ける」で溜められます。";
    list.append(li);
    return;
  }

  items.forEach((item, index) => {
    const li = document.createElement("li");

    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = `${index + 1} ページ目`;
    const src = thumbnails.get(item.id);
    if (src) img.src = src;
    li.append(img);

    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("strong");
    title.textContent = `${index + 1}. ${MODE_LABEL[item.meta.mode]} / ${item.meta.dpi}dpi`;
    const detail = document.createElement("span");
    detail.textContent = `${item.meta.width} x ${item.meta.height} / 約 ${(item.meta.byteSize / 1024).toFixed(0)} KB`;
    meta.append(title, detail);

    // 何枚も溜めた後で「1 枚ブレていた」に気づけるよう、一覧にも出す
    const verdict = pageSharpness.get(item.id);
    if (verdict === "blurry" || verdict === "soft") {
      const flag = document.createElement("span");
      flag.className = "flag";
      flag.textContent = verdict === "blurry" ? "ブレている可能性" : "やや甘い";
      meta.append(flag);
    }
    li.append(meta);

    const ops = document.createElement("div");
    ops.className = "ops";
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "↑";
    up.setAttribute("aria-label", "前に移動");
    up.disabled = index === 0;
    up.addEventListener("click", () => {
      pages.move(item.id, -1);
      renderPageList();
    });
    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "↓";
    down.setAttribute("aria-label", "後ろに移動");
    down.disabled = index === items.length - 1;
    down.addEventListener("click", () => {
      pages.move(item.id, 1);
      renderPageList();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "削除";
    remove.addEventListener("click", () => {
      pages.remove(item.id);
      thumbnails.delete(item.id);
      pageSharpness.delete(item.id);
      refreshPagesBadge();
      renderPageList();
    });
    ops.append(up, down, remove);
    li.append(ops);
    list.append(li);
  });
}

async function addCurrentPage(): Promise<void> {
  if (!lastScan) return;
  const id = await pages.add(
    lastScan.page,
    lastScan.mode,
    lastScan.dpi,
    lastScan.outputWidth,
    lastScan.outputHeight,
  );
  thumbnails.set(id, makeThumbnail());
  pageSharpness.set(id, lastScan.sharpness.verdict);
  refreshPagesBadge();
  say(`${pages.size} ページ目として追加しました。`);

  // 12.2MP の元画像は 49MB ある。ページに移した後は不要なので手放す。
  // 次の撮影でカメラが 12.2MP を流すため、抱えたままだと端末が苦しい
  captured = null;
  displayCanvas = null;
  lastScan = null;
  lastOutput = null;

  // カメラを開けなかったときは結果画面に留めず、一覧を見せる(二重追加を防ぐ)
  if (!(await startCamera())) {
    renderPageList();
    show("pages");
  }
}

async function savePages(): Promise<void> {
  if (pages.size === 0) return;
  setBusy(true, "PDF にまとめています…");
  await nextFrame();
  try {
    const bytes = await pages.toPdf();
    setBusy(false);
    const saved = await exportBytes(bytes, "application/pdf", "pdf", false);
    if (saved) {
      // 保存できたページは持ち続けない。端末に溜め込まない方針(D-005)を保つ
      pages.clear();
      thumbnails.clear();
      pageSharpness.clear();
      refreshPagesBadge();
      renderPageList();
      show("home");
    }
  } catch (err) {
    fail("まとめて保存", err);
  } finally {
    setBusy(false);
  }
}

/* ---------------- 画面の配線 ---------------- */

function setSegmented(group: HTMLElement, value: string, attribute: string): void {
  for (const button of group.querySelectorAll<HTMLButtonElement>("button")) {
    button.classList.toggle("on", button.dataset[attribute] === value);
  }
}

function syncOptionVisibility(): void {
  $("whiten-row").hidden = mode === "bilevel";
  $("bw-advanced").hidden = mode !== "bilevel";
}

$("btn-start").addEventListener("click", () => {
  void startCamera();
});

$<HTMLInputElement>("file-import").addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  setBusy(true, "画像を読み込んでいます…");
  await nextFrame();
  try {
    const source = new FileImportSource(file);
    await source.start();
    const frame = await source.capture();
    setBusy(false);
    stopCamera();
    await goToAdjust(frame, "写真から読み込む");
  } catch (err) {
    setBusy(false);
    fail("写真から読み込む", err);
  }
});

$("btn-shutter").addEventListener("click", async () => {
  if (!camera) return;
  const active = camera;
  setBusy(true, "撮影しています…");
  await nextFrame();
  try {
    const frame = await active.capture();
    setBusy(false);
    stopCamera();
    await goToAdjust(frame, "撮影");
  } catch (err) {
    setBusy(false);
    fail("撮影", err);
  }
});

$("btn-torch").addEventListener("click", async () => {
  if (!camera) return;
  const button = $<HTMLButtonElement>("btn-torch");
  const next = button.classList.toggle("primary");
  const ok = await camera.setTorch(next);
  if (!ok) {
    button.classList.toggle("primary", !next);
    say("ライトを操作できませんでした。", "TORCH_UNAVAILABLE");
  }
});

$("btn-cancel-capture").addEventListener("click", () => {
  stopCamera();
  show("home");
});

$("btn-back-capture").addEventListener("click", () => {
  void startCamera();
});

$("btn-full-quad").addEventListener("click", () => {
  if (!editor || !displayCanvas) return;
  // 検出が大きく外れたときの逃げ道。画像そのものを切り出す
  editor.setQuad(fullFrameQuad(displayCanvas.width, displayCanvas.height));
});

$("btn-reset-quad").addEventListener("click", () => {
  if (!editor || !detectedQuad) return;
  editor.setQuad(scaleQuad(detectedQuad, displayScale));
});

$("btn-process").addEventListener("click", () => {
  void process();
});

$("mode-group").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
  if (!button) return;
  mode = button.dataset.mode as RenderMode;
  setSegmented($("mode-group"), mode, "mode");
  syncOptionVisibility();
  persist();
});

$("format-group").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-format]");
  if (!button) return;
  format = button.dataset.format as OutputFormat;
  setSegmented($("format-group"), format, "format");
  persist();
});

$("dpi-group").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-dpi]");
  if (!button) return;
  dpi = Number(button.dataset.dpi);
  setSegmented($("dpi-group"), String(dpi), "dpi");
  persist();
});

$<HTMLInputElement>("opt-whiten").addEventListener("change", (event) => {
  whiten = (event.target as HTMLInputElement).checked;
  persist();
});

$<HTMLInputElement>("opt-strength").addEventListener("change", (event) => {
  binarizeStrength = Number((event.target as HTMLInputElement).value);
  persist();
});

$("binarize-group").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-binarize]");
  if (!button) return;
  binarizeMethod = button.dataset.binarize as BinarizeMethod;
  setSegmented($("binarize-group"), binarizeMethod, "binarize");
  persist();
});

$("btn-save").addEventListener("click", () => {
  void save(false);
});
$("btn-download").addEventListener("click", () => {
  void save(true);
});
$("btn-back-adjust").addEventListener("click", () => {
  show("adjust");
  requestAnimationFrame(() => editor?.layout());
});
$("btn-home").addEventListener("click", () => {
  captured = null;
  lastOutput = null;
  show("home");
});

$("btn-add-page").addEventListener("click", () => {
  void addCurrentPage();
});

$("nav-pages").addEventListener("click", () => {
  renderPageList();
  show("pages");
});

$("btn-pages-add-more").addEventListener("click", () => {
  void startCamera();
});

$("btn-pages-clear").addEventListener("click", () => {
  if (pages.size === 0) return;
  if (!confirm(`${pages.size} ページをすべて破棄します。よろしいですか?`)) return;
  pages.clear();
  thumbnails.clear();
  pageSharpness.clear();
  refreshPagesBadge();
  renderPageList();
  say("すべて破棄しました。");
});

$("btn-pages-save").addEventListener("click", () => {
  void savePages();
});

$("nav-diag").addEventListener("click", () => {
  fillTable($<HTMLTableElement>("diag-env"), collectEnvironment());
  const table = $<HTMLTableElement>("diag-errors");
  const records = getFailures();
  if (records.length === 0) {
    table.innerHTML = '<tr class="empty"><td colspan="2">記録された失敗はありません。</td></tr>';
  } else {
    fillTable(
      table,
      Object.fromEntries(
        records.map((r, i) => [`${i + 1}. ${r.at} ${r.where}`, r.detail ? `${r.code} — ${r.detail}` : r.code]),
      ),
    );
  }
  show("diag");
});

$("btn-diag-back").addEventListener("click", () => {
  if (pages.size > 0 && !captured) {
    renderPageList();
    show("pages");
    return;
  }
  show(captured ? "adjust" : "home");
});

$("btn-copy-diag").addEventListener("click", async () => {
  const env = collectEnvironment();
  const lines = ["# pwa-doc-scan 診断", "", "| 項目 | 値 |", "|---|---|"];
  for (const [k, v] of Object.entries(env)) lines.push(`| ${k} | ${v} |`);
  lines.push("", "## 直近の失敗", "");
  const records = getFailures();
  if (records.length === 0) lines.push("なし");
  for (const r of records) lines.push(`- ${r.at} ${r.where}: ${r.code}${r.detail ? ` — ${r.detail}` : ""}`);
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    say("コピーしました。");
  } catch {
    say("クリップボードに書き込めませんでした。");
  }
});

/* ---------------- 全体 ---------------- */

// 撮り溜めたページは端末に保存しないため、閉じると消える。黙って失わせない
globalThis.addEventListener("beforeunload", (event) => {
  if (pages.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
});

// HC-2: 画面が隠れたらカメラを止める。バックグラウンド撮影を構造的に不可能にする
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") stopCamera();
});

globalThis.addEventListener("resize", () => {
  if (!views.adjust.hidden) editor?.layout();
  if (!views.capture.hidden) drawOverlay();
});

if (isStandalone()) {
  $("permission-note").textContent =
    "カメラの使用許可を求められます。ホーム画面から起動している場合、許可はアプリを開き直すたびに聞かれます(iOS の仕様です)。";
}

refreshPagesBadge();
setSegmented($("mode-group"), mode, "mode");
setSegmented($("format-group"), format, "format");
setSegmented($("dpi-group"), String(dpi), "dpi");
setSegmented($("binarize-group"), binarizeMethod, "binarize");
$<HTMLInputElement>("opt-whiten").checked = whiten;
$<HTMLInputElement>("opt-strength").value = String(binarizeStrength);
syncOptionVisibility();
show("home");

if ("serviceWorker" in navigator) {
  globalThis.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
      // オフライン動作が使えないだけで、アプリ自体は動く
      recordFailure("Service Worker", "SW_REGISTER_FAILED");
    });
  });
}

export {};
