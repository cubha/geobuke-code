// 0.9.0 A3a ST5 — format.ts의 시맨틱 Tone을 Ink <Text color> 값으로 번역.
// 그린 브랜드톤(accent) + BLOCK=red·승인대기=yellow 시맨틱 사수(project_0_9_0_tui_stack_decision.md).
import type { Tone } from "../format.js";

// 0.10.1 — 외곽 '+' 프레임(Frame.tsx)과 Title Area 배경 채움(SplashHeader.tsx)이 같은 톤을
// 써야 텍스처가 이어져 보인다. 각자 하드코딩하면 한쪽만 바뀌는 drift 위험(scope-critic 지적,
// 2026-07-21)이라 여기 단일 소스로 공유한다.
// 0.11.0(2026-07-22, 사용자 확정 — 시안 아티팩트 a9ee1e59) — CLI 전체가 검정 톤인데 밝은
// ANSI green이 화면 대부분(프레임 배경·5개 패널 테두리·제목)을 덮어 과도하게 도드라진다는
// 지적으로 톤다운. 녹색은 마스코트·워드마크·상태 마커(❯·gated ✓·● 활성)에만 남긴다 — 그
// 마커들은 toneColor("accent")=계속 "green"으로 무변경, 아래 3개 토큰만 신설/교체.
export const FRAME_COLOR = "#1d2b22"; // 배경 '+' 텍스처 — 체감 녹색의 최대 면적이라 가장 어둡게.
export const BORDER_COLOR = "#47554c"; // 패널(대화창·카드·사이드바·토글 패널 3종) 테두리.
export const PANEL_TITLE_COLOR = "#8a958d"; // 패널 제목 텍스트("게이트 활성"·"📁 repos" 등).

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
