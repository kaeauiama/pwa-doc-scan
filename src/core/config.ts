/**
 * 閾値・定数の単一ソース。
 * ドキュメントには数値を直書きせず、この名前で参照すること(CLAUDE.md 参照)。
 */

export const CONFIG = {
  binarize: {
    /** 既定の手法。U-01 として未確定。実書類で比較して決める */
    method: "sauvola" as "sauvola" | "bradley",
    /** 局所窓のサイズ = 長辺 / windowDivisor(minWindow で下限を切る。常に奇数化) */
    windowDivisor: 16,
    minWindow: 15,
    /** Sauvola: T = m * (1 + k * (s / R - 1)) */
    sauvolaK: 0.2,
    sauvolaR: 128,
    /** Bradley-Roth: T = m * (1 - k) */
    bradleyK: 0.15,
  },

  output: {
    /** 既定の出力 DPI。U-03 として未確定(M0.5 の解像度実測後に決める) */
    defaultDpi: 200,
    dpiPresets: [150, 200, 300] as const,
  },

  paper: {
    /** A4。用紙サイズは mm で持ち、DPI と組み合わせて px を導出する */
    a4: { widthMm: 210, heightMm: 297 },
  },

  limits: {
    /**
     * Sauvola は二乗和の積分画像に Float64Array を要するため
     * width*height*8 バイトを追加で確保する。これを超える入力では
     * bradley にフォールバックする(端末メモリ保護)。
     */
    sauvolaMaxPixels: 8_000_000,
  },
} as const;

export const MM_PER_INCH = 25.4;

/** 用紙サイズ(mm)と DPI から出力ピクセル数を求める */
export function paperPixels(widthMm: number, heightMm: number, dpi: number) {
  return {
    width: Math.round((widthMm / MM_PER_INCH) * dpi),
    height: Math.round((heightMm / MM_PER_INCH) * dpi),
  };
}
