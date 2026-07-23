// 0.10.4 ST4 — 개선1(입력창 '/' 스킬 드롭다운) 순수 코어. 판정·필터·완성 텍스트는 렌더-비의존
// 순수 함수라 이 파일에 둔다(app.tsx는 배선만 — 프로젝트 확립 원칙, editor.ts/format.ts와 동일).
// 스킬 "실발동"은 SDK 네이티브 로드가 아니라 클라이언트측 SKILL.md 본문 주입이다 — engine.ts가
// settingSources:[]로 고정돼 있어(anti-recursion 불변식, PreToolUse stdin hook 재귀 방지) 스폰된
// claude agent-sdk 세션은 스킬을 스스로 로드하지 않는다. composeSkillPrompt가 그 주입 문자열을
// 순수하게 합성한다.
import type { SkillInfoWithOrigin } from "./skills.js";

const SLASH_QUERY_RE = /^\/([A-Za-z0-9_-]*)$/;

/**
 * 입력창 첫 줄에서 슬래시 자동완성 쿼리를 판정한다(순수). "/"+영숫자/하이픈/언더스코어만 있는
 * 동안만 열림 상태(쿼리 문자열 반환, "/" 단독이면 빈 문자열=전체 목록). 공백이 등장하면(인자 입력
 * 단계로 전환) 혹은 슬래시가 첫 글자가 아니면 닫힘(null) — 드롭다운은 파생 상태라 별도 open
 * 플래그 없이 이 함수 하나로 열림/닫힘이 결정된다(에디터-드롭다운 상태 desync 원천 차단).
 */
export function computeSlashQuery(firstLine: string): string | null {
  const m = firstLine.match(SLASH_QUERY_RE);
  return m ? m[1] : null;
}

/** 쿼리로 스킬 후보를 필터링한다(순수, 대소문자 무시 prefix 매칭). 빈 쿼리는 전체 반환. */
export function filterSkills<T extends { name: string }>(skills: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  return skills.filter((s) => s.name.toLowerCase().startsWith(q));
}

/** 드롭다운에서 스킬을 확정 선택했을 때 입력창에 채울 텍스트(순수) — 뒤에 인자를 이어 칠 공간으로 공백 1개. */
export function completeSlashText(name: string): string {
  return `/${name} `;
}

const SKILL_PROMPT_SEPARATOR = "\n\n---\n\n";

/**
 * 스킬 SKILL.md 본문과 사용자 입력을 하나의 프롬프트로 합성한다(순수). 본문을 먼저 둬 모델이
 * 지시문을 사용자 요청보다 먼저 읽도록 한다 — 순서 자체가 계약(테스트로 고정).
 */
export function composeSkillPrompt(skillBody: string, userText: string): string {
  return `${skillBody.trim()}${SKILL_PROMPT_SEPARATOR}${userText}`;
}

export type { SkillInfoWithOrigin };
