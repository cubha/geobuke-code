// 거북이코드 계측 레이어 (M1~M3) — B-모드 hook 관측 프록시.
// 1차 자산 = 원시 events.jsonl(append-only). 메트릭은 그 위의 thin 집계.
// ⚠️ 진짜 M1(post-gate 시나리오위반율)은 A-mode 사후대조 필요 — B-모드는 churn 약신호만.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { gbcDir } from "./store.js";
import { serializeCapped } from "./jsonl-line.js";

/** missing[] 캡 (항목 수 / 항목당 길이) */
const MAX_MISSING_ITEMS = 20;
const MAX_MISSING_LEN = 200;

export type EventKind =
  | "gate"
  | "scope"
  | "defer-add"
  | "defer-start"
  | "defer-resolve"
  | "defer-withdraw"
  | "defer-reopen"
  /** 0.9.3 ST4 — gate review --ack: 게이트가 잘못 도출한 누락을 "이미 완료"로 직접 등록(open 미경유). */
  | "gate-ack"
  | "spec-add"
  | "spec-clear"
  | "gate-reset"
  | "done"
  | "verify"
  | "bypass";

// doc-skip(0.5.5): 문서 확장자 하드가드가 judge 미호출 통과시킨 편집 — 조용한 우회 방지 계측.
// specHash=""로 기록돼 M1(churn)·M2(block만)에선 자동 제외, M3(session 키)엔 기존 문서편집과 동일 참여.
// block-repeat(0.9.3 ST2): 같은 작업단위에서 이미 안내된 missing 셋의 재발화 — 통과는 됐지만 block과
// 동종(형제 누락이 여전히 미해소)이라 pass로 뭉뚱그리지 않고 별도 태그로 계측한다.
export type GateDecision = "pass" | "block" | "block-repeat" | "failopen" | "cached" | "doc-skip";

/** scope 판정 계측 열거형(프라이버시: 코드 본문·사유 없이 enum 태그만). */
export type ScopeAxis = "missing" | "scope" | "rung1" | "rung2" | "rung3";
export type ScopeContextMode = "none" | "editText" | "grep";
export type ScopeTransport = "api" | "cli";

/** events.jsonl 한 줄. 메타데이터만 — 코드 diff 본문은 절대 넣지 않는다. */
export interface GateEvent {
  /** ISO 타임스탬프 */
  at: string;
  /** session_id (hook 이벤트) 또는 "" (CLI 이벤트) */
  session: string;
  /** 현재 명세 해시 (작업단위/서브유닛 키) */
  specHash: string;
  kind: EventKind;
  /** gate 이벤트: Edit/Write/MultiEdit */
  tool?: string;
  /** gate 이벤트 한정 */
  decision?: GateDecision;
  /** block 이벤트: 게이트가 잡은 형제 케이스 */
  missing?: string[];
  /** 게이트 시점 활성 defer 수 */
  deferCount?: number;
  /** 게이트 시점 spec 케이스 수 */
  specCount?: number;
  // --- scope 이벤트(축A/축B) 계측 태그 (0.5.2) — 전부 enum, 코드 본문 없음 ---
  /** 이 이벤트가 다루는 축 카테고리(coarse) */
  axis?: ScopeAxis;
  /** scope: 파급반경 판정 결과 */
  axisA?: "ok" | "broken" | "unknown";
  /** scope: 최소구현 사다리 rung */
  rung?: "rung1" | "rung2" | "rung3" | "none" | "unknown";
  /** scope: 판정 시점 계획 명세 존재 여부 */
  spec_present?: boolean;
  /** scope: 판정에 쓰인 컨텍스트 모드 */
  context_mode?: ScopeContextMode;
  /** scope: 판정 트랜스포트 */
  transport?: ScopeTransport;
  /** scope: 탐색 컨텍스트 부재로 축소 판정(정직 고지)했는지 */
  degraded?: boolean;
}

/** missing[]을 항목 수/길이로 캡 */
function capMissing(missing: string[]): string[] {
  return missing
    .slice(0, MAX_MISSING_ITEMS)
    .map((m) => (m.length > MAX_MISSING_LEN ? m.slice(0, MAX_MISSING_LEN) : m));
}

/**
 * 이벤트를 한 줄 JSON으로 직렬화. missing[]을 캡하고, 그래도 MAX_LINE을 넘으면
 * missing을 요약 토큰으로 대체해 라인 길이를 보장한다(O_APPEND atomic).
 */
export function serializeEvent(e: GateEvent): string {
  const out: GateEvent = { ...e };
  if (out.missing) out.missing = capMissing(out.missing);
  return serializeCapped(out, (o) => {
    if (o.missing) o.missing = [`${e.missing?.length ?? 0} items (truncated)`];
  });
}

/** jsonl 원시 텍스트를 이벤트 배열로 파싱 (빈 줄·깨진 줄 skip) */
export function parseEvents(raw: string): GateEvent[] {
  const out: GateEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object" && typeof obj.kind === "string") {
        out.push(obj as GateEvent);
      }
    } catch {
      /* 깨진 줄 skip */
    }
  }
  return out;
}

/**
 * 크로스-repo 집계용 — 비어있지 않은 specHash만 'repoTag::specHash'로 태깅한다. 빈 specHash("")는
 * 센티넬(작업단위 식별 불가)이라 그대로 둬 computeMetrics의 교차세션 제외 가드를 유지한다. repo간
 * 동일/boilerplate spec 해시가 firstPassAt·groupKey(session 없는 CLI 이벤트)에서 충돌해 churn을
 * 교차오염시키는 것을 막는다(session-UUID 키인 M2/M3 hook 이벤트는 원래 안전).
 */
export function tagEventsWithRepo(events: GateEvent[], repoTag: string): GateEvent[] {
  return events.map((e) => (e.specHash ? { ...e, specHash: `${repoTag}::${e.specHash}` } : e));
}

/** M1~M3 집계 결과 (thin reporter용) */
export interface Metrics {
  totalEvents: number;
  /** M3 — 작업단위당 edit 반복(재호출 proxy) */
  m3: {
    workUnits: number;
    totalEdits: number;
    avgEditsPerUnit: number;
    maxEditsPerUnit: number;
    multiEditUnits: number;
  };
  /** M2 — 게이트 적중 vs 도중발견 */
  m2: {
    gateCaught: number;
    blocks: number;
    deferred: number;
    midDiscoveryRatio: number;
  };
  /** M1 — post-gate 재작업(B-모드 churn 약신호) */
  m1: {
    resets: number;
    churnAfterPass: number;
    note: string;
  };
  /** scope — 축A/축B 사후 판정 롤업(0.5.2). */
  scope: {
    /** scope 이벤트 총 수(편집별 1건) */
    total: number;
    /** 파급반경 broken(축A) 건수 */
    rippleBroken: number;
    /** 최소구현 사다리 걸림(rung1/2/3) 건수 */
    rungHits: number;
    /** 탐색 컨텍스트 부족으로 축소 판정(degraded) 건수 */
    degraded: number;
  };
}

const M1_NOTE =
  "B-모드 약신호(churn proxy) — 진짜 M1(post-gate 시나리오 위반율)은 A-mode 사후대조 필요. " +
  "spec.md 비었을 때(specHash='')는 작업단위 식별 불가라 churn 집계에서 제외(교차세션 합산 방지).";

/** 그룹핑 키: session 우선, 없으면 specHash(CLI 이벤트 상관) */
function groupKey(e: GateEvent): string {
  return e.session || e.specHash;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 이벤트 배열 → M1/M2/M3 집계. 순수함수(파일 I/O 없음). */
export function computeMetrics(events: GateEvent[]): Metrics {
  const gate = events.filter((e) => e.kind === "gate");

  // M3 — 작업단위(session||specHash)별 gate 이벤트 수 = edit 반복 proxy
  const perUnit = new Map<string, number>();
  for (const e of gate) perUnit.set(groupKey(e), (perUnit.get(groupKey(e)) ?? 0) + 1);
  const counts = [...perUnit.values()];
  const workUnits = counts.length;
  const totalEdits = gate.length;
  const maxEditsPerUnit = counts.length ? Math.max(...counts) : 0;
  const multiEditUnits = counts.filter((c) => c > 1).length;
  const avgEditsPerUnit = workUnits ? round3(totalEdits / workUnits) : 0;

  // M2 — 게이트적중(Σ block.missing) vs 도중발견(defer-add)
  const blockEvents = gate.filter((e) => e.decision === "block");
  const gateCaught = blockEvents.reduce((s, e) => s + (e.missing?.length ?? 0), 0);
  const deferred = events.filter((e) => e.kind === "defer-add").length;
  const denom = gateCaught + deferred;
  const midDiscoveryRatio = denom ? round3(deferred / denom) : 0;

  // M1 — specHash별 first pass 이후의 churn(spec-add/clear/gate-reset/defer-add).
  // ⚠️ 빈 specHash("")는 spec.md 없는 작업단위라 식별 불가 → 교차세션 합산을 막기 위해 제외.
  const firstPassAt = new Map<string, string>();
  for (const e of gate) {
    if (e.decision !== "pass" || !e.specHash) continue;
    const cur = firstPassAt.get(e.specHash);
    if (cur === undefined || e.at < cur) firstPassAt.set(e.specHash, e.at);
  }
  const CHURN_KINDS: EventKind[] = ["spec-add", "spec-clear", "gate-reset", "defer-add"];
  let churnAfterPass = 0;
  for (const e of events) {
    if (!CHURN_KINDS.includes(e.kind) || !e.specHash) continue;
    const passAt = firstPassAt.get(e.specHash);
    if (passAt !== undefined && e.at > passAt) churnAfterPass++;
  }
  const resets = events.filter((e) => e.kind === "gate-reset").length;

  // scope(축A/축B) 롤업 — 사후 판정이 실제로 무엇을 잡는지 관측(theater 방지).
  const scopeEvents = events.filter((e) => e.kind === "scope");
  const rippleBroken = scopeEvents.filter((e) => e.axisA === "broken").length;
  const rungHits = scopeEvents.filter(
    (e) => e.rung === "rung1" || e.rung === "rung2" || e.rung === "rung3",
  ).length;
  const degradedScope = scopeEvents.filter((e) => e.degraded === true).length;

  return {
    totalEvents: events.length,
    m3: { workUnits, totalEdits, avgEditsPerUnit, maxEditsPerUnit, multiEditUnits },
    m2: { gateCaught, blocks: blockEvents.length, deferred, midDiscoveryRatio },
    m1: { resets, churnAfterPass, note: M1_NOTE },
    scope: {
      total: scopeEvents.length,
      rippleBroken,
      rungHits,
      degraded: degradedScope,
    },
  };
}

/**
 * 마지막 *적용된* 코드 편집(gate) 시각 — verify provenance 신선도 기준(0.6.0).
 * 포함: pass/cached/failopen(편집이 실제 반영됨). 제외: block(편집 거부됨=미반영),
 * doc-skip(문서 편집=테스트 결과 무효화 안 함), 비gate 이벤트. 없으면 null(신선도 미평가).
 */
export function lastAppliedEditAt(events: GateEvent[]): string | null {
  const APPLIED: GateDecision[] = ["pass", "cached", "failopen"];
  let latest: string | null = null;
  for (const e of events) {
    if (e.kind !== "gate" || !e.decision || !APPLIED.includes(e.decision)) continue;
    if (latest === null || e.at > latest) latest = e.at;
  }
  return latest;
}

// events.jsonl 무제한 성장 갭(인프라 리뷰 지적, confidence 65)은 리팩토링 범위(기능 무변경) 밖이라
// 이 배치에서 다루지 않는다 — scope-critic 판정(2026-07-24): 로테이션 도입은 온-디스크 보존 정책을
// 바꾸는 실질 기능 변경이라 별도 승인 SubTask로 분리해야 한다. 필요 시 다음 페이즈에서 재검토.

/** events.jsonl에 이벤트 1줄 append. 실패는 무시(계측이 개발 흐름을 막지 않음). */
export function logEvent(cwd: string, event: GateEvent): void {
  if (process.env.GBC_NO_METRICS === "1") return;
  try {
    appendFileSync(join(gbcDir(cwd), "events.jsonl"), serializeEvent(event) + "\n");
  } catch {
    /* 계측 실패는 무시 */
  }
}
