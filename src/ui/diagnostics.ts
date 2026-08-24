export interface FailureRecord {
  readonly at: string;
  readonly where: string;
  readonly code: string;
  readonly detail?: string;
}

const failures: FailureRecord[] = [];

/** 失敗は理由コードとともに残す(REQ-14 / REQ-15)。回避策は出さない。 */
export function recordFailure(where: string, code: string, detail?: string): void {
  failures.unshift({
    at: new Date().toLocaleTimeString("ja-JP"),
    where,
    code,
    detail,
  });
  if (failures.length > 20) failures.length = 20;
}

export function getFailures(): readonly FailureRecord[] {
  return failures;
}

function canShareFiles(): boolean {
  try {
    const file = new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" });
    return navigator.canShare ? navigator.canShare({ files: [file] }) : false;
  } catch {
    return false;
  }
}

function hasCompressionStream(): boolean {
  try {
    new CompressionStream("deflate");
    return true;
  } catch {
    return false;
  }
}

/**
 * standalone 判定。iOS では manifest があっても display-mode より
 * navigator.standalone のほうが確実だった(D-022)ので両方見る。
 */
export function isStandalone(): boolean {
  const legacy = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return legacy || matchMedia("(display-mode: standalone)").matches;
}

export function collectEnvironment(): Record<string, string | boolean | number> {
  const displayMode =
    ["standalone", "fullscreen", "minimal-ui", "browser"].find((m) =>
      matchMedia(`(display-mode: ${m})`).matches,
    ) ?? "?";

  return {
    "HTTPS (secure context)": globalThis.isSecureContext,
    "カメラ API": !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    "ファイル共有": canShareFiles(),
    "PDF 生成 (CompressionStream)": hasCompressionStream(),
    "ホーム画面から起動": isStandalone(),
    "display-mode": displayMode,
    "Service Worker": "serviceWorker" in navigator,
    "論理コア数": navigator.hardwareConcurrency || 0,
    "画面": `${screen.width}x${screen.height} @dpr ${devicePixelRatio}`,
    UA: navigator.userAgent,
  };
}
