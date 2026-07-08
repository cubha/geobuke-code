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

/**
 * 한 세션의 사후대조 채점 후보(순수 선별 결과). 실판정(LLM)은 judge.ts judgeM1Violation이 별도 수행.
 * anchorAt = 세션 첫 *적용* 판정(pass/cached) 시각. edits = 앵커 직전 게이트된 편집 1건 + 앵커 이후
 * 전부 — 실측(2026-07-08 코퍼스): tool_use 레코드가 gate 이벤트보다 0.001~3s 선행(assistant 스트림
 * →hook 발화 순서)하므로 순수 "이후" 필터는 게이트된 편집 자체를 누락한다.
 */
export interface ScoringCandidate {
  session: string;
  /** 채점 앵커 — 세션 첫 pass/cached gate 이벤트 시각 */
  anchorAt: string;
  /** 앵커 gate 이벤트의 specHash(명세 본문 resolve 축 — 현행 spec.md 또는 archive 대조) */
  specHash: string;
  /** 채점 대상 편집(tool_use + file 있는 레코드만) */
  edits: ExtractionRecord[];
}

/** STUB(ST2 RED) — 조인 결과에서 채점 후보를 순수 선별한다. */
export function selectScoringCandidates(joins: SessionJoin[]): ScoringCandidate[] {
  void joins;
  throw new Error("STUB: selectScoringCandidates 미구현(ST2 RED)");
}

/**
 * events⨝records를 session_id로 조인한다(순수). 세션 = 비어있지 않은 session을 가진 이벤트 ∪ extraction
 * 레코드의 합집합. CLI 이벤트(session="")는 조인키 부재로 어떤 세션에도 귀속하지 않는다 — 단 버리는 게
 * 아니라 시퀀스 분류(classifyBlockOutcome)가 원본 배열에서 시간창으로 직접 읽는다(분업).
 * 세션 내 events/records는 at 오름차순(시퀀스 분석 전제), 세션 순서는 첫 관측 시각 순.
 */
export function joinBySession(events: GateEvent[], records: ExtractionRecord[]): SessionJoin[] {
  const map = new Map<string, SessionJoin>();
  const get = (session: string): SessionJoin => {
    let j = map.get(session);
    if (!j) {
      j = { session, events: [], records: [], scorable: false };
      map.set(session, j);
    }
    return j;
  };
  for (const e of events) {
    if (!e.session) continue; // CLI 이벤트 — 조인키 부재로 미귀속
    get(e.session).events.push(e);
  }
  for (const r of records) {
    if (!r.session) continue;
    const j = get(r.session);
    j.records.push(r);
    j.scorable = true; // extraction 존재 = A-mode 세션 = 채점 가능
  }
  const byAt = (a: { at: string }, b: { at: string }) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  const joins = [...map.values()];
  for (const j of joins) {
    j.events.sort(byAt);
    j.records.sort(byAt);
  }
  // 세션 순서 = 첫 관측(이벤트든 레코드든 이른 쪽) 시각 순 — 리포트 안정성.
  const firstAt = (j: SessionJoin) =>
    [j.events[0]?.at, j.records[0]?.at].filter((x): x is string => !!x).sort()[0] ?? "";
  joins.sort((a, b) => (firstAt(a) < firstAt(b) ? -1 : firstAt(a) > firstAt(b) ? 1 : 0));
  return joins;
}
