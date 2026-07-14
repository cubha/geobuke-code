import type { EditToolInput } from "./types.js";

const MAX_FIELD = 4000; // 프롬프트 비대화/지연 방지용 필드 절단 길이

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
