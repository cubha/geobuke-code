// jsonl 한 줄 크기 상한 가드 — metrics.ts(events.jsonl)·extraction.ts(extraction.jsonl) 공용 추출
// (2026-07-24 리팩토링 R1). 두 sink 모두 O_APPEND atomic 보장을 위해 한 줄이 이 상한을 넘지 않아야
// 한다.
export const MAX_LINE = 4096;

/**
 * obj를 JSON 직렬화하되 MAX_LINE을 넘으면 shrink(obj)로 축소 후 재직렬화하고, 그래도 넘으면
 * 강제 절단한다(마지막 방어선 — 항상 한 줄, 항상 MAX_LINE 미만을 보장).
 */
export function serializeCapped<T>(obj: T, shrink: (obj: T) => void): string {
  let line = JSON.stringify(obj);
  if (line.length >= MAX_LINE) {
    shrink(obj);
    line = JSON.stringify(obj);
  }
  if (line.length >= MAX_LINE) line = line.slice(0, MAX_LINE - 1);
  return line;
}
