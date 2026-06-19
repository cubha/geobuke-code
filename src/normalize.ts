import type { EditToolInput } from "./types.js";

const MAX_FIELD = 4000; // 프롬프트 비대화/지연 방지용 필드 절단 길이

function clip(s: string | undefined): string {
  if (!s) return "";
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "\n…(절단됨)" : s;
}

/**
 * PreToolUse tool_input(Edit/Write/MultiEdit)을 게이트 프롬프트용
 * diff 유사 텍스트로 정규화한다. tool_name으로 분기.
 */
export function normalizeEdit(toolName: string, input: EditToolInput): string {
  const file = input.file_path ?? "(파일경로 없음)";

  // Write: 파일 전체 생성/덮어쓰기
  if (toolName === "Write" || (input.content !== undefined && !input.old_string && !input.edits)) {
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
