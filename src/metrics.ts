// 거북이코드 계측 레이어 (M1~M3) — B-모드 hook 관측 프록시.
// 1차 자산 = 원시 events.jsonl(append-only). 메트릭은 그 위의 thin 집계.
// ⚠️ 진짜 M1(post-gate 시나리오위반율)은 A-mode 사후대조 필요 — B-모드는 churn 약신호만.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gbcDirPath, ensureGbcDir } from "./store.js";
import { serializeCapped } from "./jsonl-line.js";
import { rotateJsonlIfOversize } from "./jsonl-rotate.js";

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
  // --- 오탐 RCA 계측(2026-08-07) — 코드 본문·경로는 넣지 않는다(메타만) ---
  /** judge에 전달된 [현재 파일 상태] 원문 바이트 길이. readCurrentFile null(신규 파일 등)이면 undefined. */
  fileBytes?: number;
  /** fileBytes가 judge.ts MAX_CURRENT_FILE(8000)을 초과해 절단됐는지. fileBytes 없으면 undefined. */
  truncated?: boolean;
  /** P2b(ST12) grep 근거주입 2단계 재판정이 실제로 발화(매치 有)했는지. 재판정 자체가 없었으면 undefined. */
  evidenceUsed?: boolean;
  /** evidenceUsed일 때만 의미 — 재판정이 verdict/missing을 바꿨는지(오탐 해소 신호). */
  evidenceFlip?: boolean;
  /**
   * grep 예산 소진으로 **조회조차 못 한** missing 케이스가 있었는지(0.12.0 F-14). 재판정 발화
   * 여부와 독립 — 매치 0으로 block이 유지된 판정에서 "근거 없음"과 "못 봄"을 가르는 유일한 신호다.
   */
  evidenceBudgetExhausted?: boolean;
  /** 위 소진의 사유 — `count`=심볼 개수 예산, `time`=벽시계 예산(해소법이 다르다). 없으면 undefined. */
  evidenceBudgetReason?: "count" | "time";
  /**
   * 근거수집(collectCaseEvidence)이 예외로 끝났는가(0.12.0 F-10). 이 값이 쌓이면 P2b가 조용히
   * 무력화된 상태 — `evidenceUsed` 0과 겉보기가 같아(둘 다 재판정 미발화) 이 필드 없이는
   * "차단이 드물어 안 돌았다"와 "grep이 깨져 못 돈다"를 구분할 수 없다.
   */
  evidenceFailed?: boolean;
  /**
   * 근거 총량 상한(`MAX_EVIDENCE_CONTEXT_CHARS`)을 넘겨 **프롬프트에서 잘려나간** 케이스 수
   * (0.12.0 F-9). `evidenceBudgetExhausted`(grep을 못 돌림)와 다른 축이다 — 이쪽은 grep은 돌았는데
   * 결과가 프롬프트 예산에 안 들어간 경우다. 둘 다 0이어야 "근거를 다 보고 내린 판정"이 된다.
   */
  evidenceDropped?: number;
  // --- 작업단위 적용이력(0.12.3 P2a) — 코드 본문·경로는 넣지 않는다(메타만) ---
  /** judge에 실제로 실린 적용이력 엔트리 수. 원장이 비었으면(appliedContext 없음) undefined. */
  appliedCount?: number;
  /** 프롬프트 총량 상한(applied.ts MAX_APPLIED_CONTEXT_CHARS)으로 잘려나간 엔트리 수. 0이면 undefined. */
  appliedDropped?: number;
  /** 원장 읽기(loadApplied)가 예외로 끝났는가 — fail-open으로 흡수됐으나 조용히 사라지지 않게 계측. */
  appliedFailed?: boolean;
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

/**
 * `gbc metrics --since` 인자 해석(0.12.0 F-1) — ISO 8601 절대시각 또는 상대 표기(`7d`·`24h`·`30m`).
 * 해석 불가면 **null**을 돌려주고 호출부가 명시적으로 실패시킨다: 조용히 전체 집계로 떨어지면
 * "필터가 걸렸다고 믿는데 안 걸린" 상태가 되어, 희석된 수치를 신규 창 수치로 오독하게 된다
 * (이 플래그의 존재 이유가 정확히 그 희석을 막는 것이다).
 */
export function parseSince(spec: string, now: Date = new Date()): Date | null {
  const s = spec.trim();
  if (!s) return null;
  const rel = /^(\d+)([dhm])$/.exec(s);
  if (rel) {
    const unitMs = rel[2] === "d" ? 86_400_000 : rel[2] === "h" ? 3_600_000 : 60_000;
    const d = new Date(now.getTime() - Number(rel[1]) * unitMs);
    // 극단값은 Invalid Date가 되는데 **객체 자체는 truthy**라 호출부의 `if (!since)` 가드를 그대로
    // 통과하고 뒤의 toISOString()에서 RangeError로 죽었다(security-auditor 실측). 이 함수가 선언한
    // "해석 실패는 명시적 실패" 불변식대로 null로 마감한다.
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * 시간창 필터(0.12.0 F-1). 경계는 **포함**(>=) — 0.12.0 설치시각을 그대로 `--since`에 넣었을 때
 * 그 시각 이벤트가 살아있어야 한다. `at`이 없거나 파싱 불가인 이벤트는 시간창에 귀속할 수 없으므로
 * 제외한다(포함시키면 어느 창에서 집계해도 항상 따라붙어 창 비교 자체를 무의미하게 만든다).
 */
export function filterEventsSince(events: GateEvent[], since: Date): GateEvent[] {
  const cutoff = since.getTime();
  return events.filter((e) => {
    const t = e.at ? Date.parse(e.at) : NaN;
    return !Number.isNaN(t) && t >= cutoff;
  });
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
  /**
   * evidence — P2b 근거주입 재판정 롤업(0.12.0 F-2). gate-core가 이벤트에 남기던 필드들이
   * 어디에도 표시되지 않아, P2b가 실제로 오탐을 해소했는지를 events.jsonl을 직접 뒤져야만 알 수
   * 있었다. 기록만 있고 보이지 않는 계측은 "측정했다"는 착각을 만든다(RCA 교훈).
   */
  evidence: {
    /** 근거주입 2단계 재판정이 실제로 돌아간 판정 수(매치 0이면 재판정 생략이라 여기 안 잡힘) */
    used: number;
    /** 그중 verdict 또는 missing 집합이 바뀐 수 = P2b가 1차 판정을 뒤집은 건수 */
    flipped: number;
    /** flipped/used — used=0이면 null(표본 0을 0%로 위장하지 않는다) */
    flipRate: number | null;
    /** 총량 상한으로 프롬프트에서 생략된 근거 케이스 수의 합(Σ evidenceDropped) */
    droppedCases: number;
    /** grep 예산 소진으로 조회조차 못 한 케이스가 있던 판정 수 */
    budgetExhausted: number;
    /** [현재 파일 상태]가 MAX_CURRENT_FILE에서 절단된 판정 수 = P2b가 존재하는 이유 */
    truncated: number;
    /** 절단율 분모 — fileBytes가 기록된(=파일 상태가 실린) 판정 수 */
    withFile: number;
    /** 근거수집이 예외로 끝난 판정 수 — 0이 아니면 P2b가 무력화된 상태다(F-10) */
    failed: number;
    /** budgetExhausted 중 **시간** 예산이 원인인 수 — 나머지는 개수 예산(해소법이 다르다) */
    budgetExhaustedByTime: number;
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

  // evidence — P2b 근거주입 롤업(0.12.0 F-2). gate 이벤트만 본다(다른 kind엔 이 필드가 없다).
  const evidenceUsed = gate.filter((e) => e.evidenceUsed === true);
  const evidenceFlipped = evidenceUsed.filter((e) => e.evidenceFlip === true).length;
  const withFile = gate.filter((e) => e.fileBytes !== undefined).length;

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
    evidence: {
      used: evidenceUsed.length,
      flipped: evidenceFlipped,
      flipRate: evidenceUsed.length ? round3(evidenceFlipped / evidenceUsed.length) : null,
      droppedCases: gate.reduce((s, e) => s + (e.evidenceDropped ?? 0), 0),
      budgetExhausted: gate.filter((e) => e.evidenceBudgetExhausted === true).length,
      truncated: gate.filter((e) => e.truncated === true).length,
      withFile,
      failed: gate.filter((e) => e.evidenceFailed === true).length,
      budgetExhaustedByTime: gate.filter((e) => e.evidenceBudgetReason === "time").length,
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

/** events.jsonl 파일 상한(바이트). 초과 시 .1로 로테이션(0.10.6 A3, extraction.ts MAX_EXTRACTION_BYTES
 * 미러) — events.jsonl 무제한 성장 갭(인프라 리뷰 지적)은 리팩토링 배치(2026-07-24)에서 "기능 변경은
 * 범위 밖"이라는 scope-critic 판정으로 한 차례 리버트됐다가, 이번 0.10.6 A3에서 정식 승인 SubTask로
 * 재도입한다. */
export const MAX_EVENTS_BYTES = 5 * 1024 * 1024;

/** .gbc/events.jsonl 경로. */
export function eventsPath(cwd: string): string {
  return join(gbcDirPath(cwd), "events.jsonl");
}

/** events.jsonl에 이벤트 1줄 append — 상한 이상이면 append 전에 1세대 로테이션(jsonl-rotate.ts,
 * extraction.ts와 동일 정책). 실패는 무시(계측이 개발 흐름을 막지 않음). */
export function logEvent(cwd: string, event: GateEvent, opts: { maxBytes?: number } = {}): void {
  if (process.env.GBC_NO_METRICS === "1") return;
  const maxBytes = opts.maxBytes ?? MAX_EVENTS_BYTES;
  try {
    ensureGbcDir(cwd);
    const path = eventsPath(cwd);
    rotateJsonlIfOversize(path, maxBytes);
    appendFileSync(path, serializeEvent(event) + "\n");
  } catch {
    /* 계측 실패는 무시 */
  }
}

/**
 * 로테이션된 .1 세대(있으면)+현행 세대를 시간순(과거→최근)으로 병합해 읽는다(0.10.6 A4) —
 * events.jsonl이 MAX_EVENTS_BYTES를 넘겨 로테이션된 뒤에도 M1(churn)·M2/M3 집계가 넘어간 이벤트를
 * 계속 반영하게 한다. "현행 세대만 읽기"는 로테이션 시점마다 오탐율·churn 분모가 조용히 리셋되는
 * 관측 결함이라 기각했다(설계 결정, plan 단계). .1 세대가 없으면(로테이션 미발생 — 흔한 경우) 기존
 * 동작(현행 세대만)과 동일하다. 1세대 로테이션이라 병합 총량도 ≤2×MAX_EVENTS_BYTES로 유계다.
 *
 * extraction.ts 소비처(cmdScore의 parseExtraction)는 여전히 현행 세대만 읽는 비대칭이 의도돼 있다 —
 * extraction은 채점 후보 소스라 최근분으로 충분하지만, events는 집계 1차 자산이라 연속성이 더
 * 중요하다(0.10.6 plan 설계 근거).
 */
export function readEventsMerged(cwd: string): GateEvent[] {
  const path = eventsPath(cwd);
  const rotatedPath = path.replace(/\.jsonl$/, ".1.jsonl");
  const rotated = existsSync(rotatedPath) ? parseEvents(readFileSync(rotatedPath, "utf8")) : [];
  const current = existsSync(path) ? parseEvents(readFileSync(path, "utf8")) : [];
  return [...rotated, ...current];
}
