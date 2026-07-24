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

/**
 * ref 문자열로 items 중 대상을 고른다(defer.ts selectTargets · review.ts selectCases 공용 추출,
 * 2026-07-24 리팩토링 — R1). 세 형태 지원:
 * - "all": eligible 술어를 통과하는 전부
 * - 공백구분 토큰이 전부 정수: 복수 인덱스(1-base). 인덱스는 명시 지정이라 적격 무시(사용자가 번호를 안다)
 * - 그 외: 통째로 부분 텍스트 1건 매칭(eligible 항목 중) — 공백 포함 문구 하위호환
 * 빈 ref → []("" 이 항상 첫 항목을 매칭하는 오탐 방지). eligible 미지정 시 전부 적격(review.ts처럼
 * 상태 개념이 없는 호출자용).
 */
export function selectByRef<T>(
  items: T[],
  ref: string,
  getText: (item: T) => string,
  eligible: (item: T) => boolean = () => true,
): T[] {
  const trimmed = ref.trim();
  if (trimmed === "") return [];
  if (trimmed === "all") return items.filter(eligible);

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const allInts = tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));
  if (allInts) {
    const out: T[] = [];
    for (const t of tokens) {
      const idx = Number.parseInt(t, 10);
      if (idx >= 1 && idx <= items.length && !out.includes(items[idx - 1])) {
        out.push(items[idx - 1]);
      }
    }
    return out;
  }
  const found = items.find((it) => eligible(it) && getText(it).includes(trimmed));
  return found ? [found] : [];
}
