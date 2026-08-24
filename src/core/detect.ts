import { downscaleGray } from "./resize.ts";
import { flattenIllumination, gaussianBlur, sobelEdges } from "./edges.ts";
import { angleDistance, houghLines, intersect, lineSupport, signedDistance } from "./hough.ts";
import { refineQuad } from "./refine.ts";
import type { RefineOptions } from "./refine.ts";
import type { Line } from "./hough.ts";
import type { Gray8, Point, Quad } from "./types.ts";

/** 検出できなかった理由。UI にそのまま出す(REQ-14: 沈黙の失敗にしない)。 */
export type DetectFailureReason =
  | "NO_EDGES"
  | "NO_LINE_CANDIDATES"
  | "NO_PERPENDICULAR_GROUPS"
  | "NO_VALID_QUAD";

export interface DetectDiagnostics {
  readonly workingWidth: number;
  readonly workingHeight: number;
  readonly edgeCount: number;
  readonly edgeThreshold: number;
  readonly lineCount: number;
  readonly quadsConsidered: number;
}

export type DetectResult =
  | {
      ok: true;
      /** 入力画像の座標系での四隅(TL, TR, BR, BL) */
      quad: Quad;
      /** 4 辺のうち最も裏づけの弱い辺のエッジ被覆率(0..1) */
      confidence: number;
      /** 四角形が画像面積に占める割合 */
      areaRatio: number;
      diagnostics: DetectDiagnostics;
    }
  | { ok: false; reason: DetectFailureReason; diagnostics: DetectDiagnostics };

export interface DetectOptions {
  /** 検出を行う縮小画像の長辺(px) */
  workingLongEdge?: number;
  /**
   * ガウシアンを掛ける回数。本文の行も強い直線として検出されるため、
   * 文字テクスチャが潰れるまでぼかす必要がある(1 回では紙の縁が順位で埋もれる)。
   */
  blurPasses?: number;
  /** Hough から取り出す直線候補の本数 */
  maxLines?: number;
  /** エッジとして残す画素の割合 */
  edgeKeepRatio?: number;
  /** 四角形が画像面積に占めるべき最小割合 */
  minAreaRatio?: number;
  /** 対辺として認めるための最小間隔(短辺に対する比) */
  minSeparationRatio?: number;
  /** 平行とみなす角度の許容(度)。これを超えると別グループ */
  groupToleranceDeg?: number;
  /** 各グループから使う直線の本数の上限 */
  maxLinesPerGroup?: number;
  /** 粗検出のあと高解像度で辺を当て直すか(既定 true) */
  refine?: boolean;
  refineOptions?: RefineOptions;
}

const DEFAULTS = {
  /**
   * 480px だと本文の行が Hough 上位を占め、紙の縁が 100 位以下に沈むことがある。
   * 320px まで落とすと文字テクスチャが潰れ、文字の太さ 5〜24px の全域で
   * 4 辺すべてが上位 6 位以内に入る(計測して決めた値)。
   */
  workingLongEdge: 320,
  blurPasses: 2,
  maxLines: 96,
  edgeKeepRatio: 0.12,
  minAreaRatio: 0.15,
  minSeparationRatio: 0.15,
  groupToleranceDeg: 30,
  maxLinesPerGroup: 12,
  refine: true,
} as const;

function polygonArea(q: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

function isConvex(q: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    const c = q[(i + 2) % q.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 重心まわりの角度で並べ、左上に最も近い点を先頭にする(TL, TR, BR, BL)。 */
export function orderQuad(points: readonly Point[]): Quad {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < best) {
      best = s;
      start = i;
    }
  }
  const r = [sorted[start], sorted[(start + 1) % 4], sorted[(start + 2) % 4], sorted[(start + 3) % 4]];
  return [r[0], r[1], r[2], r[3]] as Quad;
}

/**
 * 書類の四隅を自動検出する。
 *
 * 縮小 → ぼかし → Sobel → Hough で直線候補を取り、
 * 直交する 2 グループから対辺を 1 組ずつ選んで四角形を組む。
 * 「エッジ被覆率 x 面積比」が最大の組を採る。
 *
 * 面積比を掛けているのは、本文の行も直線として強く出るため。
 * 行だけで組んだ四角形は必ず紙面より小さくなるので、面積で外側が選ばれる。
 */
export function detectDocumentQuad(src: Gray8, options: DetectOptions = {}): DetectResult {
  const opt = { ...DEFAULTS, ...options };
  const { image: working, scale } = downscaleGray(src, opt.workingLongEdge);
  // 影による縁と文字のコントラスト逆転を先に潰す
  let blurred: Gray8 = flattenIllumination(working);
  for (let i = 0; i < opt.blurPasses; i++) blurred = gaussianBlur(blurred);
  const edges = sobelEdges(blurred, opt.edgeKeepRatio);

  const baseDiag: DetectDiagnostics = {
    workingWidth: working.width,
    workingHeight: working.height,
    edgeCount: edges.edgeCount,
    edgeThreshold: edges.threshold,
    lineCount: 0,
    quadsConsidered: 0,
  };

  if (edges.edgeCount < 32) return { ok: false, reason: "NO_EDGES", diagnostics: baseDiag };

  const lines = houghLines(edges, { maxLines: opt.maxLines });
  const diag = { ...baseDiag, lineCount: lines.length };
  if (lines.length < 4) return { ok: false, reason: "NO_LINE_CANDIDATES", diagnostics: diag };

  const tol = (opt.groupToleranceDeg * Math.PI) / 180;
  const reference = lines[0].theta;
  const groupA: Line[] = [];
  const groupB: Line[] = [];
  for (const l of lines) {
    const d = angleDistance(l.theta, reference);
    if (d <= tol) groupA.push(l);
    else if (d >= Math.PI / 2 - tol) groupB.push(l);
  }
  if (groupA.length < 2 || groupB.length < 2) {
    return { ok: false, reason: "NO_PERPENDICULAR_GROUPS", diagnostics: diag };
  }

  const center: Point = { x: working.width / 2, y: working.height / 2 };

  /**
   * グループ内の絞り込み。投票数の上位だけを採ると、数の多い本文行が枠線を押し出す。
   * 紙の縁は必ず画像中心から最も遠い直線のひとつなので、
   * 「投票数の上位」と「中心から遠い上位」を両側それぞれで取り、和集合を候補にする。
   */
  function shortlist(group: Line[]): Line[] {
    const half = Math.max(2, Math.floor(opt.maxLinesPerGroup / 2));
    const picked = new Set<Line>();
    for (const side of [1, -1]) {
      const onSide = group.filter((l) => Math.sign(signedDistance(l, center)) === side);
      for (const l of onSide.slice(0, half)) picked.add(l);
      const byDistance = [...onSide].sort(
        (x, y) => Math.abs(signedDistance(y, center)) - Math.abs(signedDistance(x, center)),
      );
      for (const l of byDistance.slice(0, half)) picked.add(l);
    }
    return [...picked];
  }

  const a = shortlist(groupA);
  const b = shortlist(groupB);
  if (a.length < 2 || b.length < 2) {
    return { ok: false, reason: "NO_PERPENDICULAR_GROUPS", diagnostics: diag };
  }
  const support = new Map<Line, number>();
  for (const l of [...a, ...b]) support.set(l, lineSupport(l, edges));

  const minSep = opt.minSeparationRatio * Math.min(working.width, working.height);
  const imageArea = working.width * working.height;
  const marginX = working.width * 0.2;
  const marginY = working.height * 0.2;

  /** 画像中心を挟み、十分離れている対辺の組 */
  function oppositePairs(group: Line[]): [Line, Line][] {
    const out: [Line, Line][] = [];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const di = signedDistance(group[i], center);
        const dj = signedDistance(group[j], center);
        if (di * dj >= 0) continue; // 中心が両方の同じ側 = 書類を囲んでいない
        if (Math.abs(di) + Math.abs(dj) < minSep) continue;
        out.push([group[i], group[j]]);
      }
    }
    return out;
  }

  const pairsA = oppositePairs(a);
  const pairsB = oppositePairs(b);

  let best: { quad: Quad; score: number; confidence: number; areaRatio: number } | null = null;
  let considered = 0;

  for (const [a1, a2] of pairsA) {
    for (const [b1, b2] of pairsB) {
      const raw = [intersect(a1, b1), intersect(a1, b2), intersect(a2, b1), intersect(a2, b2)];
      if (raw.some((p) => p === null)) continue;
      const pts = raw as Point[];
      if (
        pts.some(
          (p) =>
            !Number.isFinite(p.x) ||
            !Number.isFinite(p.y) ||
            p.x < -marginX ||
            p.y < -marginY ||
            p.x > working.width + marginX ||
            p.y > working.height + marginY,
        )
      ) {
        continue;
      }
      const quad = orderQuad(pts);
      if (!isConvex(quad)) continue;
      const areaRatio = polygonArea(quad) / imageArea;
      if (areaRatio < opt.minAreaRatio) continue;

      considered++;
      const confidence = Math.min(
        support.get(a1)!,
        support.get(a2)!,
        support.get(b1)!,
        support.get(b2)!,
      );
      const score = confidence * areaRatio;
      if (!best || score > best.score) best = { quad, score, confidence, areaRatio };
    }
  }

  const finalDiag = { ...diag, quadsConsidered: considered };
  if (!best) return { ok: false, reason: "NO_VALID_QUAD", diagnostics: finalDiag };

  // 縮小画像の座標系から元画像の座標系へ戻す
  const inv = 1 / scale;
  const coarse = best.quad.map((p) => ({ x: p.x * inv, y: p.y * inv })) as unknown as Quad;
  const quad = opt.refine ? refineQuad(src, coarse, opt.refineOptions) : coarse;

  return { ok: true, quad, confidence: best.confidence, areaRatio: best.areaRatio, diagnostics: finalDiag };
}
