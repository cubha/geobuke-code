// 0.9.0 A3a ST5 — format.ts의 시맨틱 Tone을 Ink <Text color> 값으로 번역.
// 그린 브랜드톤(accent) + BLOCK=red·승인대기=yellow 시맨틱 사수(project_0_9_0_tui_stack_decision.md).
import type { Tone } from "../format.js";

export function toneColor(tone: Tone): string | undefined {
  switch (tone) {
    case "accent":
      return "green";
    case "warn":
      return "yellow";
    case "danger":
      return "red";
    case "dim":
      return "gray";
    case "code":
      return "cyan";
    case "plain":
    default:
      return undefined;
  }
}
