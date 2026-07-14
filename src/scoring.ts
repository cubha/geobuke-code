// A2 사후대조 채점 (0.8.0) — extraction.jsonl(A-mode 엔진 실제 행위) ⨝ events.jsonl(게이트 판정)을
// session_id로 조인해 진짜 M1(pass 후 시나리오 위반율)과 오탐율(block 정당성)을 산출한다.
// 구조: 조인·후보선별·시퀀스분류는 순수함수(결정론, TDD 회귀락) / LLM 채점은 별도 명령(gbc score)이
// 트리거 — A1의 mapSdkMessage(순수)/runEngine(E2E) 분리 미러.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { GateEvent } from "./metrics.js";
import type { ExtractionRecord } from "./extraction.js";
import { gbcDir } from "./store.js";

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
 * 조인 결과에서 채점 후보를 순수 선별한다. 후보 = scorable 세션의 *작업단위 세그먼트*별 1건.
 * 세그먼트 = 적용 판정(pass/cached)의 specHash 전환점 분리 — 한 gbc run 세션이 done→spec-add를
 * 거쳐 여러 작업단위를 낼 수 있어(scope-critic 2026-07-08 범위확대), 세션당 단일 앵커면 2번째
 * 단위의 편집이 1번째 명세로 오채점된다. 같은 해시 연속 판정은 한 단위로 병합.
 *
 * 세그먼트 시간창 = [이 앵커의 게이트된 편집 시각, 다음 세그먼트의 게이트된 편집 시각). 게이트된
 * 편집 = 앵커 직전 최근접 선행 편집 — 실측: tool_use 레코드가 gate 이벤트보다 0.001~3s 선행하므로
 * "앵커 이후"만으로는 그 편집이 빠진다. 창 시작은 직전 앵커 시각으로 클램프(선행 편집 유실 시
 * 이전 세그먼트 편집을 훔치는 것 방지). block만 있는 세션·편집 0건 세그먼트는 제외.
 */
export function selectScoringCandidates(joins: SessionJoin[]): ScoringCandidate[] {
  const out: ScoringCandidate[] = [];
  for (const j of joins) {
    if (!j.scorable) continue;
    const applied = j.events.filter(
      (e) => e.kind === "gate" && (e.decision === "pass" || e.decision === "cached"),
    );
    if (applied.length === 0) continue;
    // specHash 전환점으로 앵커 분리(연속 동일 해시는 첫 판정으로 병합).
    const anchors: GateEvent[] = [];
    for (const e of applied) {
      if (anchors.length === 0 || anchors[anchors.length - 1].specHash !== e.specHash) anchors.push(e);
    }
    const fileEdits = j.records.filter(isFileEdit); // at 정렬 전제(joinBySession)
    // 세그먼트 시작 = 게이트된 편집(앵커 직전 최근접) 시각, 없으면 앵커 시각. 직전 앵커로 클램프.
    const startAts = anchors.map((a, i) => {
      const before = fileEdits.filter((r) => r.at < a.at);
      const gatedAt = before.length ? before[before.length - 1].at : a.at;
      const prevAnchorAt = i > 0 ? anchors[i - 1].at : "";
      return gatedAt > prevAnchorAt ? gatedAt : a.at;
    });
    for (let i = 0; i < anchors.length; i++) {
      const endAt = i + 1 < anchors.length ? startAts[i + 1] : undefined;
      const edits = fileEdits.filter((r) => r.at >= startAts[i] && (endAt === undefined || r.at < endAt));
      if (edits.length === 0) continue;
      out.push({ session: j.session, anchorAt: anchors[i].at, specHash: anchors[i].specHash, edits });
    }
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
  /**
   * block → 같은 세션 block-repeat(0.9.3 ST2, 동일 missing 셋 재발화 강등): 편집은 적용됐지만
   * 침묵 누락이 **여전히 미해소**다 — self-corrected(수정으로 해소)와 근본적으로 다르다. spec 보강도
   * 없이 통과했다는 점에서 abandoned·overridden과 같은 계열이라 오탐 후보로 유지한다(scope-critic
   * 지적, 2026-07-14: block-repeat를 self-corrected로 흡수하면 "gateCaught가 아직 안 고쳐졌는데
   * self-corrected"라는 오탐 신호 은폐가 된다).
   */
  | "repeated-unresolved"
  /**
   * block → 같은 세션(CLI 시간창) gate-ack(0.9.3 ST4, `gbc gate review --ack`): 게이트 판정을
   * "잘못됐다"고 사람/에이전트가 **명시적으로 인정**한 것 — resolved-spec(정상작동)도 self-corrected
   * (모호)도 아니라 **오탐이 확정된 신호**다. SPEC_CHANGE_KINDS에 섞으면 "명세 보강으로 정상
   * 해소됨"으로 오분류돼 정반대 의미가 된다(scope-critic 지적, 2026-07-14: self-corrected에
   * 흡수되면 오탐율 지표가 ack 남용을 못 잡음 — ack가 유일한 사후 감사 채널인데 그 신호 자체가
   * 은폐되는 이중 결함).
   */
  | "acknowledged-fp"
  /** block → 이후 적용 판정 없이 gate-reset(CLI) 또는 같은 세션 bypass: 게이트 무시 = 오탐 후보 */
  | "overridden"
  /** block → 후속 이벤트 없음(재시도 포기): 오탐 후보 */
  | "abandoned"
  /**
   * block → 같은 세션 failopen: 재시도가 판정불능(judge 실패)으로 통과됨. 오탐도 정상도 아닌
   * 별도 분류 — lastAppliedEditAt이 failopen을 "적용된 편집"으로 묶는 것과 동일 기준으로 창을
   * 닫되, "fail-open≠pass" 원칙(gate-core)대로 resolved로도 오탐으로도 세지 않는다(scope-critic
   * 2026-07-08: 미분기 시 실존 failopen 이력이 abandoned로 오분류돼 오탐율이 조용히 부푼다).
   */
  | "failed-open";

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
    repeatedUnresolved: number;
    acknowledgedFp: number;
    overridden: number;
    abandoned: number;
    /** 재시도가 판정불능(failopen)으로 통과된 block 수 — 분모 제외 대상 */
    failedOpen: number;
    /** 귀속 불확실(동시 세션 혼입) 분류 수 — 신뢰도 참고 */
    ambiguous: number;
    /** fpCandidates/(totalBlocks-failedOpen) — 판정불능은 분모 제외(희석 방지, unscored 규율 미러). 분모 0이면 null */
    rate: number | null;
  };
  /** 분모 투명성 — 전체 세션 중 채점 가능(A-mode) 세션 수. */
  sessions: { total: number; scorable: number };
}

/** 후보의 편집 묶음을 judge 입력 텍스트로 포맷(순수) — 파일·도구 + text 스니펫(이미 2000자 캡). */
export function formatEditsForScore(edits: ExtractionRecord[]): string {
  return edits
    .map((e) => `- [${e.tool ?? "?"}] ${e.file ?? "(파일 미상)"}${e.text ? `\n  ${e.text}` : ""}`)
    .join("\n");
}

/** .gbc/scores.json 경로 — gbc score의 스냅샷 산출물(채점은 재실행 시 덮어씀). */
export function scoresPath(cwd: string): string {
  return join(gbcDir(cwd), "scores.json");
}

/** scores.json 로드. 부재·깨짐은 [](채점 없음으로 정직 처리 — metrics가 rate:null 표시). */
export function loadScores(cwd: string): SessionScore[] {
  try {
    if (!existsSync(scoresPath(cwd))) return [];
    const j = JSON.parse(readFileSync(scoresPath(cwd), "utf8"));
    if (!Array.isArray(j.scores)) return [];
    return j.scores.filter(
      (s: unknown): s is SessionScore =>
        !!s && typeof s === "object" && typeof (s as SessionScore).session === "string",
    );
  } catch {
    return [];
  }
}

/** scores.json 저장(스냅샷 덮어쓰기). 실패는 삼킨다(채점 출력 자체는 이미 화면에 있음). */
export function saveScores(cwd: string, scores: SessionScore[], at: string): void {
  try {
    writeFileSync(scoresPath(cwd), JSON.stringify({ at, scores }, null, 2) + "\n", "utf8");
  } catch {
    /* fail-silent */
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * 조인·분류·채점 결과를 진짜 M1로 순수 집계한다. 정직 규율 두 가지:
 * ① 위반율 분모 = 채점 완료(violated+compliant)만 — unscored를 분모에 넣으면 위반율 과소평가.
 * ② 표본 0이면 rate=null — "0%"로 뻥튀기하지 않는다(computeMetrics의 specHash="" 센티넬 정신).
 */
export function computeRealM1(
  joins: SessionJoin[],
  classifications: BlockClassification[],
  scores: SessionScore[],
): RealM1 {
  const violated = scores.filter((s) => s.verdict === "violated").length;
  const compliant = scores.filter((s) => s.verdict === "compliant").length;
  const unscored = scores.filter((s) => s.verdict === "unscored").length;
  const scored = violated + compliant;

  const count = (o: BlockOutcome) => classifications.filter((c) => c.outcome === o).length;
  const fpCandidates = classifications.filter((c) => c.fpCandidate).length;
  const totalBlocks = classifications.length;
  const failedOpen = count("failed-open");
  const classifiable = totalBlocks - failedOpen; // 판정불능 제외 분모(희석 방지)

  return {
    violation: {
      scored,
      violated,
      compliant,
      unscored,
      rate: scored ? round3(violated / scored) : null,
    },
    falsePositive: {
      totalBlocks,
      fpCandidates,
      resolvedSpec: count("resolved-spec"),
      selfCorrected: count("self-corrected"),
      repeatedUnresolved: count("repeated-unresolved"),
      acknowledgedFp: count("acknowledged-fp"),
      overridden: count("overridden"),
      abandoned: count("abandoned"),
      failedOpen,
      ambiguous: classifications.filter((c) => c.ambiguous).length,
      rate: classifiable ? round3(fpCandidates / classifiable) : null,
    },
    sessions: {
      total: joins.length,
      scorable: joins.filter((j) => j.scorable).length,
    },
  };
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
    // block-repeat(0.9.3 ST2)은 anchor로 삼지 않는다 — emit-direct(allow)라 그 자체로 이미
    // "적용됨" 상태이고, 새 관측 창을 열 필요가 없다(재발화가 원래 block의 미해결 상태를 그대로
    // 반영할 뿐, 별도 해소 시퀀스가 아님).
    if (b.kind !== "gate" || b.decision !== "block" || !b.session) continue;
    // 같은 세션의 다음 적용 판정(pass/cached/failopen/block-repeat — 편집이 실제 반영된 판정)까지가
    // 관측 창. block-repeat도 emit-direct(allow)라 "적용됨"에 포함 — 아니면 그 뒤 무관한 세션 활동을
    // 원래 block의 해소 시퀀스로 잘못 귀속시킬 수 있다.
    let endIdx = sorted.length;
    let applied = false;
    let failedOpen = false;
    let repeatedUnresolved = false;
    for (let k = i + 1; k < sorted.length; k++) {
      const e = sorted[k];
      if (
        e.kind === "gate" &&
        e.session === b.session &&
        (e.decision === "pass" || e.decision === "cached" || e.decision === "failopen" || e.decision === "block-repeat")
      ) {
        endIdx = k;
        applied = true;
        failedOpen = e.decision === "failopen";
        repeatedUnresolved = e.decision === "block-repeat";
        break;
      }
    }
    let specChanged = false;
    let ackOccurred = false;
    let overridden = false;
    let ambiguous = false;
    for (let k = i + 1; k <= Math.min(endIdx, sorted.length - 1); k++) {
      const e = sorted[k];
      if (k === endIdx && applied) break; // 창 끝(적용판정 자체)은 위에서 소비
      if (!e.session && SPEC_CHANGE_KINDS.has(e.kind)) specChanged = true;
      // gate-ack(0.9.3 ST4)는 SPEC_CHANGE_KINDS에 넣지 않는다 — "명세 보강"과 "오탐 인정"은
      // 의미가 정반대라 같은 버킷(resolved-spec)에 섞이면 안 된다(위 acknowledged-fp 주석 참조).
      if (!e.session && e.kind === "gate-ack") ackOccurred = true;
      if (!e.session && e.kind === "gate-reset") overridden = true;
      if (e.session === b.session && e.kind === "bypass") overridden = true;
      // 타 세션 gate 혼입 = CLI 이벤트 귀속 불확실(동시 세션) — 정직 표기.
      if (e.kind === "gate" && e.session && e.session !== b.session) ambiguous = true;
    }
    // failed-open이 spec 보강 여부보다 우선 — 재판정 자체가 실패했으면 resolved라 볼 수 없다.
    // repeated-unresolved도 failed-open 다음 우선순위 — 재발화로 닫힌 창은 spec이 바뀌었을 리 없다
    // (block-repeat 성립 조건 자체가 "같은 specHash"라 specChanged와는 애초에 상호배타적이지만,
    // 의도를 명시하기 위해 순서에서도 앞에 둔다). acknowledged-fp는 specChanged보다 우선 —
    // ack가 오탐 인정이라는 더 확정적 신호이고, 드물지만 ack와 spec-add가 같은 창에서 함께 일어나도
    // "오탐이었다"는 사실이 "명세 보강"에 가려지면 안 된다.
    const outcome: BlockOutcome = applied
      ? failedOpen
        ? "failed-open"
        : repeatedUnresolved
          ? "repeated-unresolved"
          : ackOccurred
            ? "acknowledged-fp"
            : specChanged
              ? "resolved-spec"
              : "self-corrected"
      : overridden
        ? "overridden"
        : "abandoned";
    out.push({
      session: b.session,
      at: b.at,
      outcome,
      fpCandidate:
        outcome === "overridden" ||
        outcome === "abandoned" ||
        outcome === "repeated-unresolved" ||
        outcome === "acknowledged-fp",
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
