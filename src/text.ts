// 케이스 텍스트 정규화 (spec.md 케이스 / defer 케이스 공용).
// spec add와 defer add가 같은 규칙을 쓰도록 단일 소스로 추출한다(W2: 비대칭 제거).

/** 한 케이스 길이 상한 — 무제한 기록·프롬프트 비대화 방지. spec/defer 공통. */
export const MAX_CASE = 500;

/**
 * 케이스 한 줄을 정규화한다: 앞뒤 공백 제거 → 내부 줄바꿈을 단일 공백으로 접기 →
 * 길이 상한 절단. readSpecCases의 단일라인 매칭·activeDeferItems 입력과 정합되게,
 * 에이전트가 멀티라인/장문을 그대로 넘겨도 안전하다.
 */
export function normalizeCase(item: string): string {
  return item.trim().replace(/\s*\n+\s*/g, " ").slice(0, MAX_CASE);
}
