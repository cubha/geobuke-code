import type { EditToolInput } from "./types.js";

// 프롬프트 비대화/지연 방지용 필드 절단 길이. judge.ts MAX_CURRENT_FILE과 값을 맞춘다(0.12.1 P3
// — 예산 불변식 content 예산 = currentFile 예산). Write 시 새 내용(이 값)과 구버전([현재 파일
// 상태], MAX_CURRENT_FILE)을 같은 기준으로 잘라야 ★★ 회귀판정(구버전에만 있던 형제가 덮어쓰기로
// 사라지는지)이 정확해진다 — 예전엔 4000 < 8000이라 새 내용만 먼저 잘려 거짓 회귀를 만들었다.
//
// 왜 Write뿐 아니라 Edit/MultiEdit의 old/new_string에도 같은 값을 쓰는가(0.12.1 실사용 실측,
// 트랜스크립트 7,385건): ⓐ Write `content`는 21.7%가 4000 초과라 위 비대칭이 상시 발생 조건이었다.
// ⓑ Edit `new_string`이 잘리면 "이 편집이 형제 케이스를 구현했다"는 사실이 judge에게 안 보여
// 정당한 편집을 차단한다(오탐) — 올리는 쪽이 옳다. ⓒ 그런데도 비용이 거의 없다: Edit `new_string`
// p99가 3,607자라 대다수 편집은 이 상수값과 무관하게 바이트 동일하고, 4000 초과는 0.75%뿐이다.
// 즉 분기를 두어 Write만 8000으로 하는 것보다 단일 상수가 단순하고 실측상 손해도 없다.
export const MAX_FIELD = 8000;

function clip(s: string | undefined): string {
  if (!s) return "";
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "\n…(절단됨)" : s;
}

/**
 * 이 편집이 파일을 통째로 생성/덮어쓰는가(Write 또는 Write와 동형 입력)(0.9.3 ST3 — judge에게
 * [현재 파일 상태]가 "곧 사라질 구버전"인지 알려주는 신호로도 재사용). normalizeEdit의 Write 분기
 * 조건과 단일 소스 — 두 곳이 각자 판정하면 드리프트한다.
 */
export function isOverwriteEdit(toolName: string, input: EditToolInput): boolean {
  return toolName === "Write" || (input.content !== undefined && !input.old_string && !input.edits);
}

/**
 * PreToolUse tool_input(Edit/Write/MultiEdit)을 게이트 프롬프트용
 * diff 유사 텍스트로 정규화한다. tool_name으로 분기.
 */
export function normalizeEdit(toolName: string, input: EditToolInput): string {
  const file = input.file_path ?? "(파일경로 없음)";

  // Write: 파일 전체 생성/덮어쓰기
  if (isOverwriteEdit(toolName, input)) {
    return `--- ${file} (전체 작성/덮어쓰기)\n+ ${clip(input.content)}`;
  }

  // MultiEdit: edits 배열
  if (toolName === "MultiEdit" || Array.isArray(input.edits)) {
    const parts = (input.edits ?? []).map(
      (e, i) => `# 편집 ${i + 1}\n- ${clip(e.old_string)}\n+ ${clip(e.new_string)}`,
    );
    return `--- ${file} (다중 편집)\n${parts.join("\n")}`;
  }

  // Edit: 단일 치환
  return `--- ${file}\n- ${clip(input.old_string)}\n+ ${clip(input.new_string)}`;
}

/** 게이트 대상(코드 변경)인 도구인지 */
export function isGatedTool(toolName: string): boolean {
  return toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit";
}
