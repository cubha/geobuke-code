// 거북이코드 계측 레이어 (M1~M3) — B-모드 hook 관측 프록시.
// 1차 자산 = 원시 events.jsonl(append-only). 메트릭은 그 위의 thin 집계.
// ⚠️ 진짜 M1(post-gate 시나리오위반율)은 A-mode 사후대조 필요 — B-모드는 churn 약신호만.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { gbcDir } from "./store.js";

/** 한 줄 이벤트의 최대 바이트 — O_APPEND atomic 보장(미만 길이) */
const MAX_LINE = 4096;
/** missing[] 캡 (항목 수 / 항목당 길이) */
const MAX_MISSING_ITEMS = 20;
const MAX_MISSING_LEN = 200;

export type EventKind =
  | "gate"
  | "defer-add"
  | "defer-start"
  | "defer-resolve"
  | "defer-reopen"
  | "spec-add"
  | "spec-clear"
  | "gate-reset"
  | "bypass";

export type GateDecision = "pass" | "block" | "failopen" | "cached";

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
  let line = JSON.stringify(out);
  if (line.length >= MAX_LINE && out.missing) {
    out.missing = [`${e.missing?.length ?? 0} items (truncated)`];
    line = JSON.stringify(out);
  }
  // 극단적 경우(다른 필드가 비대)에도 캡 — 한 줄 보장
  if (line.length >= MAX_LINE) line = line.slice(0, MAX_LINE - 1);
  return line;
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

  return {
    totalEvents: events.length,
    m3: { workUnits, totalEdits, avgEditsPerUnit, maxEditsPerUnit, multiEditUnits },
    m2: { gateCaught, blocks: blockEvents.length, deferred, midDiscoveryRatio },
    m1: { resets, churnAfterPass, note: M1_NOTE },
  };
}

/** events.jsonl에 이벤트 1줄 append. 실패는 무시(계측이 개발 흐름을 막지 않음). */
export function logEvent(cwd: string, event: GateEvent): void {
  if (process.env.GBC_NO_METRICS === "1") return;
  try {
    appendFileSync(join(gbcDir(cwd), "events.jsonl"), serializeEvent(event) + "\n");
  } catch {
    /* 계측 실패는 무시 */
  }
}
