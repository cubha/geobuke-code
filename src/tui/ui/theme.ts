// 0.9.0 A3a ST5 — format.ts의 시맨틱 Tone을 Ink <Text color> 값으로 번역.
// 그린 브랜드톤(accent) + BLOCK=red·승인대기=yellow 시맨틱 사수(project_0_9_0_tui_stack_decision.md).
import type { Tone } from "../format.js";

// 0.10.1 — 외곽 '+' 프레임(Frame.tsx)과 Title Area 배경 채움(SplashHeader.tsx)이 같은 딥그린을
// 써야 텍스처가 이어져 보인다. 각자 하드코딩하면 한쪽만 바뀌는 drift 위험(scope-critic 지적,
// 2026-07-21)이라 여기 단일 소스로 공유한다.
export const FRAME_COLOR = "#166534";

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
