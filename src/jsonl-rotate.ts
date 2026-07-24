// jsonl 파일 1세대 로테이션 — extraction.ts(0.7.0 A1)가 처음 도입한 패턴("상한 이상이면 .jsonl→
// .1.jsonl, 기존 .1은 덮어씀, 최근분 보존")을 metrics.ts(0.10.6 A3, events.jsonl)도 쓰게 되며 공용
// 추출한다(2026-07-24 리팩토링 세션에서 metrics.ts에 이식 시도했다가 scope-critic이 "기능변경은
// 리팩토링 범위 밖"으로 판정해 리버트했던 항목 — 이번엔 정식 승인된 SubTask로 재도입).
import { statSync, renameSync } from "node:fs";

/**
 * path의 현재 크기가 maxBytes 이상이면 path.replace(/\.jsonl$/, ".1.jsonl")로 이름을 바꾼다(기존
 * .1 세대는 덮어써 1세대만 유지 — 무한 성장 차단, 최근분 보존). stat/rename 실패(파일 부재·권한)는
 * 로테이션 없이 조용히 반환한다 — 호출부가 이어서 append를 시도하는 fail-silent 계약(계측이 본
 * 실행을 막지 않는다)은 이 함수 밖에서 유지된다.
 */
export function rotateJsonlIfOversize(path: string, maxBytes: number): void {
  try {
    if (statSync(path).size >= maxBytes) renameSync(path, path.replace(/\.jsonl$/, ".1.jsonl"));
  } catch {
    /* stat/rename 실패(부재·권한) → 로테이션 생략 */
  }
}
