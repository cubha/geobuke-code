// 0.11.0 ST2-1 — 도구 승인 프롬프트의 실제 변경내용 미리보기(순수, 렌더-비의존). 지금까지 generic
// canUseTool 승인(bridge.ts classifyApprovalRequest kind="generic")은 decisionReason 문구만 보여
// 사용자가 무엇을 승인하는지 알 수 없었다 — Edit/Write/MultiEdit/Bash 4종만 다루고, 그 외 도구는
// 빈 배열이다. app.tsx는 isToolPreviewSupported(아래)로 미리 걸러 4종 밖 도구는 preview 자체를
// null로 둬 기존 reason 텍스트 표시로 폴백한다(§3-C, 2026-07-27 /analyze 회귀수정 — app.tsx가
// 도구 종류와 무관하게 preview를 항상 채우던 시절엔 이 폴백이 죽은 코드였다).
import { wrapSegmentLine, sanitizeControlChars, type TextSegment, type Tone } from "./format.js";

/** 보안수정(2026-07-27, /ship 사전 QUICK 검토 Critical) — 이 파일이 렌더하는 텍스트는 도구
 * 입력 원문(Write content·Edit old/new_string·Bash command 등, 모델이 외부에서 읽은 내용을
 * 그대로 담을 수 있음)이다. sanitizeControlChars(format.ts — tailLines도 같은 이유로 공유)로
 * ESC 등 제어문자를 제거해, ANSI 이스케이프로 승인 프롬프트의 y/n/e/d 선택지 줄을 가리거나
 * 화면을 조작해 승인 판단을 오도하는 경로를 무력화한다.
 */
function seg(text: string, tone: Tone = "plain"): TextSegment[] {
  return [{ text: sanitizeControlChars(text), tone }];
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v : "";
}

/**
 * rowBudget을 넘으면 head(위쪽)에서 자르고 "…N행 생략" 마커를 붙인다. spec-add 미리보기가 쓰는
 * tailLines(문자열 tail 유지)와 의도적으로 반대 방향이다 — diff/파일 내용은 위에서부터 읽는 게
 * 자연스럽고, 어차피 head가 가장 최근 변경 맥락(파일 경로 등)을 담고 있다.
 */
function truncate(lines: TextSegment[][], rowBudget: number): TextSegment[][] {
  if (rowBudget <= 0) return [];
  if (lines.length <= rowBudget) return lines;
  const kept = lines.slice(0, Math.max(0, rowBudget - 1));
  const omitted = lines.length - kept.length;
  return [...kept, seg(`…${omitted}행 생략`, "dim")];
}

function formatEditPreview(input: Record<string, unknown>, rowBudget: number): TextSegment[][] {
  const filePath = str(input, "file_path");
  const lines: TextSegment[][] = [];
  if (filePath) lines.push(seg(filePath, "dim"));
  for (const l of splitLines(str(input, "old_string"))) lines.push(seg(`− ${l}`, "danger"));
  for (const l of splitLines(str(input, "new_string"))) lines.push(seg(`+ ${l}`, "accent"));
  return truncate(lines, rowBudget);
}

function formatWritePreview(input: Record<string, unknown>, rowBudget: number): TextSegment[][] {
  const filePath = str(input, "file_path");
  const lines: TextSegment[][] = [];
  if (filePath) lines.push(seg(filePath, "dim"));
  for (const l of splitLines(str(input, "content"))) lines.push(seg(l, "plain"));
  return truncate(lines, rowBudget);
}

/** scope-critic 지적(Task C-2 검토) — "N건 편집" 요약 1줄만으로는 무엇이 바뀌는지 알 수 없다(형태
 * known·역비용 낮음 → stub이 아니라 제대로 구현). 첫 편집의 실제 diff를 Edit과 동일하게 보여주고,
 * 나머지는 건수로 요약한다(전체를 다 보여주면 예산을 압도적으로 초과하는 흔한 경우가 많아서). */
function formatMultiEditPreview(input: Record<string, unknown>, rowBudget: number): TextSegment[][] {
  const filePath = str(input, "file_path");
  const edits = Array.isArray(input.edits) ? input.edits : [];
  const lines: TextSegment[][] = [];
  if (filePath) lines.push(seg(filePath, "dim"));
  const first = edits[0];
  if (first && typeof first === "object") {
    const e = first as Record<string, unknown>;
    for (const l of splitLines(str(e, "old_string"))) lines.push(seg(`− ${l}`, "danger"));
    for (const l of splitLines(str(e, "new_string"))) lines.push(seg(`+ ${l}`, "accent"));
  }
  if (edits.length > 1) lines.push(seg(`…${edits.length - 1}건 추가 편집`, "dim"));
  return truncate(lines, rowBudget);
}

function formatBashPreview(input: Record<string, unknown>, rowBudget: number): TextSegment[][] {
  return truncate(splitLines(str(input, "command")).map((l) => seg(l, "plain")), rowBudget);
}

const PREVIEW_SUPPORTED_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Bash"]);

/** /analyze 요구사항검증(2026-07-27) 발견 회귀 §3-C — 이 파일 헤더 주석(4행)이 "그 외 도구는
 * app.tsx가 기존 reason 표시로 폴백한다"고 주장했지만, app.tsx는 도구 종류와 무관하게 항상
 * preview를 채워 그 폴백 분기가 죽은 코드였다(WebFetch·MCP 등 4종 밖 도구 승인 시 본문이 완전히
 * 비어 렌더됨). app.tsx가 preview를 채우기 전에 먼저 이 함수로 지원 여부를 물어 널로 둘 수 있게
 * 한다 — 지원 도구 목록(4종)의 단일 소스는 formatToolPreview의 switch문이다. */
export function isToolPreviewSupported(toolName: string): boolean {
  return PREVIEW_SUPPORTED_TOOLS.has(toolName);
}

export function formatToolPreview(
  toolName: string,
  input: Record<string, unknown>,
  rowBudget: number,
): TextSegment[][] {
  if (rowBudget <= 0) return [];
  switch (toolName) {
    case "Edit":
      return formatEditPreview(input, rowBudget);
    case "Write":
      return formatWritePreview(input, rowBudget);
    case "MultiEdit":
      return formatMultiEditPreview(input, rowBudget);
    case "Bash":
      return formatBashPreview(input, rowBudget);
    default:
      return [];
  }
}

/**
 * ST2-3(0.11.0, scope-critic 지적) — formatToolPreview의 rowBudget은 논리 줄 기준이라, 폭 랩 후
 * 시각행수가 그보다 커질 수 있다(긴 diff 한 줄이 여러 줄로 wrap). app.tsx(행수 예산 계산)와
 * ApprovalBox.tsx(실제 렌더)가 **반드시 이 함수 하나만** 호출해야 두 곳의 계산이 절대 어긋나지
 * 않는다 — 따로 각자 wrap하면 drift가 생기고, 승인 선택지(y/n/e/d) 줄이 화면 밖으로 밀려날 수
 * 있다(가장 마지막에 있어 가장 먼저 밀려남 — 게이트 자체가 조작 불가능해지는 심각한 UX 결함).
 * 반환은 이미 폭(innerWidth)으로 wrap된 시각행이며, 개수가 rowBudget을 절대 넘지 않는다.
 */
export function formatToolPreviewVisual(
  toolName: string,
  input: Record<string, unknown>,
  rowBudget: number,
  innerWidth: number,
): TextSegment[][] {
  if (rowBudget <= 0) return [];
  // 논리 줄 프리필터는 넉넉히만(*4 — "긴 줄 하나가 wrap되면 대략 몇 줄" 보수적 추정, 거대한
  // Write content 전체를 join+wrap하는 낭비 방지). 그보다 더 wrap되는 예외 케이스는 아래 최종
  // cap이 어차피 잘라낸다 — 정확도가 아니라 방어가 목적인 상한이다.
  const logicalLines = formatToolPreview(toolName, input, rowBudget * 4);
  if (logicalLines.length === 0) return [];
  const joined: TextSegment[] = [];
  logicalLines.forEach((line, i) => {
    if (i > 0) joined.push({ text: "\n", tone: "plain" });
    joined.push(...line);
  });
  const wrapped = wrapSegmentLine(joined, innerWidth);
  if (wrapped.length <= rowBudget) return wrapped;
  const kept = wrapped.slice(0, Math.max(0, rowBudget - 1));
  const omitted = wrapped.length - kept.length;
  return [...kept, seg(`…${omitted}행 생략`, "dim")];
}
