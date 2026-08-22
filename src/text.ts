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
 * block-repeat(같은 작업단위에서 이미 안내한 침묵-누락을 재차단 대신 조용히 넘기는 강등)
 * 판별용 근사매칭 토크나이저. normalizeCase로 먼저 정규화한 뒤 소문자화하고,
 * 문자/숫자가 아닌 모든 연속 구간(공백·`/`·`,`·`·`·괄호 포함)을 구분자로 스플릿한다.
 * 유니코드 flag(`u`) 필수 — 한글이 섞인 문장이라 `\p{L}`이 한글 음절을 포함해야 한다.
 */
export function tokenizeCase(s: string): string[] {
  return normalizeCase(s)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

/**
 * newItems가 announced를 얼마나 재진술하고 있는지 0~1로 반환한다. 인접 바이그램 집합으로
 * 비교해 "같은 토큰들의 재조합으로 만든 다른 의미의 새 위반"을 유니그램보다 엄격히 걸러낸다
 * (예: "A가 B를 호출" 공지 후 "C가 B를 호출" — 유니그램은 B·호출이 겹쳐 과대평가하지만
 * 바이그램 "a가 b를"·"b를 호출" vs "c가 b를"·"b를 호출"은 공통이 1/2뿐이라 더 정직하다).
 * newItems 토큰이 1개 이하라 바이그램을 만들 수 없으면 유니그램 집합으로 폴백한다.
 */
export function coverageRatio(newItems: string[], announced: string[]): number {
  if (announced.length === 0) return 0;

  const announcedTokens = announced.flatMap(tokenizeCase);
  const newTokens = newItems.flatMap(tokenizeCase);

  const announcedBigrams = new Set(bigrams(announcedTokens));
  const newBigrams = new Set(bigrams(newTokens));

  let newSet = newBigrams;
  let announcedSet: Set<string> = announcedBigrams;
  if (newSet.size === 0) {
    newSet = new Set(newTokens);
    announcedSet = new Set(announcedTokens);
  }
  if (newSet.size === 0) return 0;

  let hit = 0;
  for (const g of newSet) {
    if (announcedSet.has(g)) hit++;
  }
  return hit / newSet.size;
}

/**
 * REPEAT_COVERAGE_MIN 캘리브레이션(fa-support .gbc/events.jsonl 라인 1222-1228 실측 코퍼스):
 * 양성(병합/축약/동일문 재진술) 3건 전부 coverageRatio=1.0. 음성(신규 절이 섞인 재진술)
 * coverageRatio≈0.611. 0.8은 음성 상한(0.611)과 여유(≈0.19), 양성 하한(1.0)과도 여유(≈0.2)를
 * 둔 값 — 실측 코퍼스가 4건뿐이라 문턱을 양성 최솟값에 바짝 붙이면(예: 0.95) 실전에서 어순만
 * 살짝 바뀐 정상 재진술도 걸러낼 여유가 없다고 판단해 중간값을 택함.
 */
export const REPEAT_COVERAGE_MIN = 0.8;

/** newItems가 announced의 근사 재진술(=block-repeat 대상)인지 판별한다. */
export function isAnnouncedRepeat(newItems: string[], announced: string[]): boolean {
  return coverageRatio(newItems, announced) >= REPEAT_COVERAGE_MIN;
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
