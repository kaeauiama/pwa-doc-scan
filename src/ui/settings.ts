import { CONFIG } from "../core/config.ts";
import type { BinarizeMethod } from "../core/binarize.ts";
import type { OutputFormat, RenderMode } from "../pipeline.ts";

const KEY = "pwa-doc-scan:settings:v1";

export interface Settings {
  mode: RenderMode;
  format: OutputFormat;
  dpi: number;
  whiten: boolean;
  binarizeStrength: number;
  binarizeMethod: BinarizeMethod;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "bilevel",
  format: "pdf",
  dpi: CONFIG.output.defaultDpi,
  whiten: true,
  binarizeStrength: CONFIG.binarize.defaultStrength,
  binarizeMethod: CONFIG.binarize.method,
};

const MODES: RenderMode[] = ["bilevel", "grayscale", "color"];
const FORMATS: OutputFormat[] = ["pdf", "image"];
const METHODS: BinarizeMethod[] = ["sauvola", "bradley"];

/**
 * 出力の設定だけを端末に覚えておく。
 *
 * **画像やその派生物は一切置かない**(HC-3)。ここに入るのはモードや DPI といった
 * 選択の記憶だけで、書類の中身は残らない。
 * 毎回選び直さずに済むこと自体もだが、閾値を実写で詰める(U-01)ときに
 * 同じ設定で何枚も撮れることのほうが効く。
 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      mode: MODES.includes(parsed.mode as RenderMode) ? (parsed.mode as RenderMode) : DEFAULT_SETTINGS.mode,
      format: FORMATS.includes(parsed.format as OutputFormat)
        ? (parsed.format as OutputFormat)
        : DEFAULT_SETTINGS.format,
      dpi: CONFIG.output.dpiPresets.includes(parsed.dpi as never) ? (parsed.dpi as number) : DEFAULT_SETTINGS.dpi,
      whiten: typeof parsed.whiten === "boolean" ? parsed.whiten : DEFAULT_SETTINGS.whiten,
      binarizeStrength:
        typeof parsed.binarizeStrength === "number" &&
        parsed.binarizeStrength >= 0 &&
        parsed.binarizeStrength < CONFIG.binarize.strengthSteps.sauvola.length
          ? Math.round(parsed.binarizeStrength)
          : DEFAULT_SETTINGS.binarizeStrength,
      binarizeMethod: METHODS.includes(parsed.binarizeMethod as BinarizeMethod)
        ? (parsed.binarizeMethod as BinarizeMethod)
        : DEFAULT_SETTINGS.binarizeMethod,
    };
  } catch {
    // 壊れた値が入っていても既定で動く。設定が原因でアプリが起動しないのは避ける
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // 保存できなくても動作に影響しない
  }
}
