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

/** 파일 편집 레코드인가(채점 대상 필터) — tool_use이면서 file이 있는 것만. */
function isFileEdit(r: ExtractionRecord): boolean {
  return r.kind === "tool_use" && typeof r.file === "string" && r.file.length > 0;
}

/**
 * 조인 결과에서 채점 후보를 순수 선별한다. 후보 = scorable 세션 중 적용 판정(pass/cached) 앵커가
 * 있고 편집이 1건 이상인 세션. block만 있는 세션(적용된 편집 없음)·extraction 없는 B-모드 세션·
 * 편집 0건 세션은 제외 — 채점할 "실제 반영된 작업"이 없다.
 */
export function selectScoringCandidates(joins: SessionJoin[]): ScoringCandidate[] {
  const out: ScoringCandidate[] = [];
  for (const j of joins) {
    if (!j.scorable) continue;
    const anchor = j.events.find(
      (e) => e.kind === "gate" && (e.decision === "pass" || e.decision === "cached"),
    );
    if (!anchor) continue;
    const fileEdits = j.records.filter(isFileEdit);
    // 앵커 이후 편집 전부 + 앵커 직전(가장 가까운 선행) 편집 1건 = 게이트된 편집 자체.
    // 실측: tool_use 레코드가 gate 이벤트보다 0.001~3s 선행하므로 "이후"만으로는 그 편집이 빠진다.
    const after = fileEdits.filter((r) => r.at >= anchor.at);
    const before = fileEdits.filter((r) => r.at < anchor.at);
    const gated = before.length ? [before[before.length - 1]] : []; // records는 at 정렬 전제(joinBySession)
    const edits = [...gated, ...after];
    if (edits.length === 0) continue;
    out.push({ session: j.session, anchorAt: anchor.at, specHash: anchor.specHash, edits });
  }
  return out;
}

/**
 * block 판정의 사후 행동 분류(오탐율의 grounding). LLM 재판정이 아니라 *행동신호*로 판정하는 이유:
 * 게이트 자체가 LLM(haiku)이라 재판정은 일치도 측정이지 truth가 아니다(0.5.5 문서 오판정 전례).
 * 차단 이후 실제로 일어난 일이 차단의 정당성을 말해준다.
 */
export type BlockOutcome =
  /** block → spec 보강(spec-add/clear) → 같은 세션 pass/cached: 차단이 명세 보강을 유도 = 정상작동 */
  | "resolved-spec"
  /** block → spec 변화 없이 같은 세션 pass/cached: 편집 수정으로 통과 — 정상도 오탐도 아닌 모호 */
  | "self-corrected"
  /** block → 이후 적용 판정 없이 gate-reset(CLI) 또는 같은 세션 bypass: 게이트 무시 = 오탐 후보 */
  | "overridden"
  /** block → 후속 이벤트 없음(재시도 포기): 오탐 후보 */
  | "abandoned";

export interface BlockClassification {
  session: string;
  /** block 시각 */
  at: string;
  outcome: BlockOutcome;
  /** 오탐 후보 여부(overridden|abandoned) */
  fpCandidate: boolean;
  /** 시간창에 타 세션 gate 이벤트 혼입 — CLI 이벤트(session="") 귀속이 불확실함을 정직 표기 */
  ambiguous: boolean;
}

/** 세션 1건의 LLM 사후대조 채점 결과(gbc score가 산출·저장, computeRealM1이 집계). */
export interface SessionScore {
  session: string;
  verdict: "violated" | "compliant" | "unscored";
  uncovered: string[];
  reason?: string;
  /** 채점 시각 */
  at?: string;
}

/** 진짜 M1 집계 결과 — 위반율(LLM 사후대조)과 오탐율(행동신호)을 정직한 분모와 함께 노출. */
export interface RealM1 {
  /** 위반율 — 분모는 *채점 완료*(violated+compliant)만. unscored를 분모에 넣으면 위반율이 과소평가된다. */
  violation: {
    scored: number;
    violated: number;
    compliant: number;
    unscored: number;
    /** violated/scored. 채점 0건이면 null(0으로 뻥튀기 금지) */
    rate: number | null;
  };
  /** 오탐율 — 행동신호(classifyBlockOutcome) 기반. */
  falsePositive: {
    totalBlocks: number;
    fpCandidates: number;
    resolvedSpec: number;
    selfCorrected: number;
    overridden: number;
    abandoned: number;
    /** 귀속 불확실(동시 세션 혼입) 분류 수 — 신뢰도 참고 */
    ambiguous: number;
    /** fpCandidates/totalBlocks. block 0건이면 null */
    rate: number | null;
  };
  /** 분모 투명성 — 전체 세션 중 채점 가능(A-mode) 세션 수. */
  sessions: { total: number; scorable: number };
}

/** STUB(ST4 RED) — 조인·분류·채점 결과를 진짜 M1로 순수 집계한다. */
export function computeRealM1(
  joins: SessionJoin[],
  classifications: BlockClassification[],
  scores: SessionScore[],
): RealM1 {
  void joins;
  void classifications;
  void scores;
  throw new Error("STUB: computeRealM1 미구현(ST4 RED)");
}

/** spec 보강으로 볼 CLI 이벤트(차단 사유 해소 행동). */
const SPEC_CHANGE_KINDS: ReadonlySet<string> = new Set(["spec-add", "spec-clear"]);

/**
 * block 이벤트별 후속 시퀀스를 행동신호로 분류한다(순수). 원본 events 배열을 그대로 받는 이유:
 * CLI 이벤트(session="")는 조인 불가라 SessionJoin 밖에 있고, 여기서 시간창으로 읽는다(joinBySession
 * 주석의 분업). 시간창 = (block.at, 같은 세션 다음 적용판정.at] — 적용판정 없으면 스트림 끝까지.
 * ⚠️ 한계(정직 표기): CLI 이벤트는 세션 귀속이 불가해 시간창에 *타 세션* gate가 혼입되면 어느 세션의
 * spec-add인지 확정 불가 → ambiguous=true로 표기만 하고 분류는 유지(소비자가 신뢰도 판단).
 */
export function classifyBlockOutcome(events: GateEvent[]): BlockClassification[] {
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const out: BlockClassification[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    if (b.kind !== "gate" || b.decision !== "block" || !b.session) continue;
    // 같은 세션의 다음 적용 판정(pass/cached)까지가 이 block의 관측 창.
    let endIdx = sorted.length;
    let applied = false;
    for (let k = i + 1; k < sorted.length; k++) {
      const e = sorted[k];
      if (
        e.kind === "gate" &&
        e.session === b.session &&
        (e.decision === "pass" || e.decision === "cached")
      ) {
        endIdx = k;
        applied = true;
        break;
      }
    }
    let specChanged = false;
    let overridden = false;
    let ambiguous = false;
    for (let k = i + 1; k <= Math.min(endIdx, sorted.length - 1); k++) {
      const e = sorted[k];
      if (k === endIdx && applied) break; // 창 끝(적용판정 자체)은 위에서 소비
      if (!e.session && SPEC_CHANGE_KINDS.has(e.kind)) specChanged = true;
      if (!e.session && e.kind === "gate-reset") overridden = true;
      if (e.session === b.session && e.kind === "bypass") overridden = true;
      // 타 세션 gate 혼입 = CLI 이벤트 귀속 불확실(동시 세션) — 정직 표기.
      if (e.kind === "gate" && e.session && e.session !== b.session) ambiguous = true;
    }
    const outcome: BlockOutcome = applied
      ? specChanged
        ? "resolved-spec"
        : "self-corrected"
      : overridden
        ? "overridden"
        : "abandoned";
    out.push({
      session: b.session,
      at: b.at,
      outcome,
      fpCandidate: outcome === "overridden" || outcome === "abandoned",
      ambiguous,
    });
  }
  return out;
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
