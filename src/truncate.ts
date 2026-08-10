/**
 * [현재 파일 상태] 절단 전략(0.12.1 P3, RCA 후속 — project_gate_false_positive_rca).
 *
 * 기존 head-only 절단(judge.ts MAX_CURRENT_FILE)은 8000자를 넘는 파일에서 절단면 뒤쪽에 있는
 * 정당 기구현 형제 케이스를 항상 놓쳐 미탐(형제를 "침묵 누락"으로 재차단)을 유발했다(RCA ⓐ).
 * 이 모듈은 head 고정분(import·타입정의 등 항상 필요한 상단부)은 그대로 보장하면서, 편집 대상
 * 케이스와 관련된 위치(old_string 앵커) 주변을 윈도우로 추가 포함시켜 그 미탐을 줄인다.
 *
 * 원칙:
 * - **줄 경계 정렬**: 어느 구간도 줄 중간에서 자르지 않는다(모델이 잘린 토큰을 오독하는 것 방지).
 *   경계는 항상 안쪽으로(shrink) 당긴다 — 바깥으로 확장하면 예산 초과가 생길 수 있다.
 * - **head는 무조건 보장**: 앵커가 없거나(Write) 매치 실패해도 head 고정분은 항상 표시된다
 *   (기존 head-only 동작과 동형 — 이 경로가 기존 회귀락의 "특성화" 대상).
 * - **head와 겹치는 윈도우는 흡수**: head 범위 안에 이미 있는 앵커는 별도 구간을 만들지 않는다.
 * - **예산 초과 시 문서 순서대로 드롭**: 윈도우가 남은 예산에 안 맞으면 통째로 스킵한다(부분
 *   포함은 다시 줄 경계 재계산이 필요해져 결정성이 떨어진다 — 스킵이 더 단순하고 예측 가능).
 */

export interface TruncateBudget {
  /** [현재 파일 상태] 섹션 전체에 허용되는 최대 문자수. */
  totalBudget: number;
  /** head 고정분 상한(전체 예산의 일부). */
  headBudget: number;
  /** 편집 앵커 좌우로 포함할 반경(문자수). */
  windowRadius: number;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

interface Range {
  start: number;
  end: number;
}

const GAP_MARKER = "\n…(중간 생략)\n";
const TAIL_MARKER = "\n…(절단됨)";

/**
 * head 고정분(judge.ts MAX_CURRENT_FILE=8000의 절반) — RCA ⓐ가 요구하는 "import·타입정의는
 * 항상 보장" 몫. 나머지 절반은 편집 위치 주변 윈도우에 배정한다.
 */
export const HEAD_BUDGET = 4000;

/** 편집 앵커 좌우 반경 — 정당 기구현 형제(함수 단위) 한 덩어리가 대체로 들어오는 크기. */
export const WINDOW_RADIUS = 1500;

/** 겹치거나 맞닿은 구간을 하나로 병합한다(정렬 후 좌→우 스윕). */
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/** anchors 각각의 첫 매치 위치 주변(±radius)을 구간으로 만든다. 매치 실패는 조용히 스킵. */
function findAnchorRanges(content: string, anchors: string[], radius: number): Range[] {
  const ranges: Range[] = [];
  for (const a of anchors) {
    if (!a) continue;
    const idx = content.indexOf(a);
    if (idx === -1) continue;
    ranges.push({
      start: Math.max(0, idx - radius),
      end: Math.min(content.length, idx + a.length + radius),
    });
  }
  return ranges;
}

function isLineBoundary(content: string, pos: number): boolean {
  return pos === 0 || pos === content.length || content[pos - 1] === "\n";
}

/**
 * pos를 가장 가까운 줄 경계로 안쪽(shrink)으로 당긴다. "forward"는 뒤쪽 경계(줄 시작)로 미는
 * start용, "backward"는 앞쪽 경계(줄 끝 다음)로 당기는 end용.
 */
function shrinkToLineBoundary(content: string, pos: number, dir: "forward" | "backward"): number {
  if (isLineBoundary(content, pos)) return pos;
  if (dir === "forward") {
    const nl = content.indexOf("\n", pos);
    return nl === -1 ? content.length : nl + 1;
  }
  const nl = content.lastIndexOf("\n", pos - 1);
  return nl === -1 ? 0 : nl + 1;
}

export function truncateCurrentFile(content: string, anchors: string[], budget: TruncateBudget): TruncateResult {
  if (content.length <= budget.totalBudget) {
    return { text: content, truncated: false };
  }

  const headEndRaw = Math.min(budget.headBudget, budget.totalBudget, content.length);
  const headEnd = shrinkToLineBoundary(content, headEndRaw, "backward");
  const headRange: Range = { start: 0, end: headEnd };

  // head와 겹치는 부분은 윈도우에서 제거(중복 방지) — head 뒤(headEnd 이후)만 윈도우 후보.
  const rawWindows = findAnchorRanges(content, anchors, budget.windowRadius)
    .map((r) => ({ start: Math.max(r.start, headEnd), end: r.end }))
    .filter((r) => r.end > r.start);

  const alignedWindows = mergeRanges(rawWindows)
    .map((r) => ({
      start: shrinkToLineBoundary(content, r.start, "forward"),
      end: shrinkToLineBoundary(content, r.end, "backward"),
    }))
    .filter((r) => r.end > r.start);
  const finalWindows = mergeRanges(alignedWindows).sort((a, b) => a.start - b.start);

  let remaining = budget.totalBudget - (headEnd - headRange.start);
  const selectedWindows: Range[] = [];
  for (const w of finalWindows) {
    const len = w.end - w.start;
    if (len <= remaining) {
      selectedWindows.push(w);
      remaining -= len;
    }
    // 예산 초과 윈도우는 통째로 스킵(문서 순서 유지 — 뒤쪽일수록 밀려날 확률이 높음).
  }

  const allRanges = [headRange, ...selectedWindows];
  let out = "";
  let prevEnd = -1;
  for (const r of allRanges) {
    if (r.end <= r.start) continue;
    if (prevEnd >= 0 && r.start > prevEnd) out += GAP_MARKER;
    out += content.slice(r.start, r.end);
    prevEnd = r.end;
  }
  const truncated = prevEnd < content.length;
  return { text: truncated ? out + TAIL_MARKER : out, truncated };
}
