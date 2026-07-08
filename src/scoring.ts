// A2 사후대조 채점 (0.8.0) — extraction.jsonl(A-mode 엔진 실제 행위) ⨝ events.jsonl(게이트 판정)을
// session_id로 조인해 진짜 M1(pass 후 시나리오 위반율)과 오탐율(block 정당성)을 산출한다.
// 구조: 조인·후보선별·시퀀스분류는 순수함수(결정론, TDD 회귀락) / LLM 채점은 별도 명령(gbc score)이
// 트리거 — A1의 mapSdkMessage(순수)/runEngine(E2E) 분리 미러.
import type { GateEvent } from "./metrics.js";
import type { ExtractionRecord } from "./extraction.js";

/**
 * 한 세션의 게이트 판정 + 엔진 추출 묶음. scorable=false는 extraction 없는 B-모드 세션(stdin hook만) —
 * "모델이 실제로 무엇을 했나"를 볼 수 없어 진짜 M1 채점 불가를 정직 표기한다(숫자 뻥튀기 방지).
 */
export interface SessionJoin {
  session: string;
  /** 이 세션의 이벤트(at 오름차순). CLI 이벤트(session="")는 조인키 부재로 미귀속. */
  events: GateEvent[];
  /** 이 세션의 extraction 레코드(at 오름차순). */
  records: ExtractionRecord[];
  /** extraction 존재 = A-mode 세션 = 진짜 M1 채점 가능. */
  scorable: boolean;
}

/** STUB(ST1 RED) — events⨝records를 session_id로 조인한다. */
export function joinBySession(events: GateEvent[], records: ExtractionRecord[]): SessionJoin[] {
  void events;
  void records;
  throw new Error("STUB: joinBySession 미구현(ST1 RED)");
}
