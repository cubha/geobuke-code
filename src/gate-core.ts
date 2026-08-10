// PreToolUse 게이트 판정의 transport-neutral 코어 (0.7.0 A1 ST1).
// preToolUseBody(hook.ts)에서 추출 — 부수효과를 *커밋하지 않고* GateDecision 디스크립터로 반환한다.
// 호출부(stdin hook / SDK 콜백)가 effects를 커밋하고 output.mode에 따라 도구 호출에 응답한다.
// judge는 JudgeFn으로 주입 → 모델 없이 분기 결정론 단위 테스트 가능(이 추출의 회귀락 = ST4 SDK 회귀락).
// 이 파일은 hook.ts를 import하지 않는다(단방향: hook.ts → gate-core.ts). SDK/@anthropic은 judge 안에서만
// lazy import된다. defaultGateDeps가 judge를 dynamic import로 감싸는 이유는 **단위테스트 격리**다
// (핫패스 zero-dep이 아니다 — 근거 정정은 defaultGateDeps doc 참조, 0.12.0 F-16).
import { readFileSync, lstatSync } from "node:fs";
import { normalizeEdit, isGatedTool, isOverwriteEdit } from "./normalize.js";
import { loadPlanSpec, computeSpecHash } from "./spec.js";
import { isGated } from "./state.js";
import { isGoldenCapture } from "./config.js";
import { activeDeferItems, resolvedDeferItems } from "./defer.js";
import { goldenCaseId } from "./golden.js";
import { nowIso } from "./time.js";
import { normalizeCase } from "./text.js";
import { readPendingReview } from "./review.js";
// evidence.ts는 judge.ts와 달리 무거운 외부 SDK가 없다(node:child_process만, 코어 모듈) — judge처럼
// lazy dynamic import로 감쌀 이유가 없어 정적 import한다(지연 로딩 규율은 @anthropic-ai/sdk류 외부
// 패키지에 대한 것이지 순수·grep 유틸까지 확장 적용하지 않는다 — F-16 정정 반영).
import { collectCaseEvidence, computeDeletionScope, formatEvidenceContext } from "./evidence.js";
import { redactSecrets } from "./extraction.js";
import type { CaseEvidence, DeletionScope } from "./evidence.js";
import type { EditToolInput, Verdict, GoldenCase, PendingReview } from "./types.js";
import type { GateEvent } from "./metrics.js";

/** 코드 파일 확장자(scope 큐잉 대상 — 문서/설정 편집은 파급반경·사다리 판정 대상 아님). */
export const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cpp|cc|cs|kt|swift|scala)$/i;

/**
 * 문서 파일 확장자 — 게이트 결정론 하드가드(0.5.5, 결함A). "동작과 무관한 편집(문서) → 무조건
 * pass"는 GATE_SYSTEM 1단계의 확정 제품 의도지만, "코드를 서술하는 문서"(분석 보고서·README 기능
 * 서술)가 haiku의 1단계 분류를 반복적으로 뒤집는 실증 실패 모드(3회: README·분석MD×2 — judge가
 * "동작과 무관하나"라고 자인하면서 block, ANALYSIS-gbc-defect-rca-2026-07-03). 프롬프트는 하드가드가
 * 아니므로 코드에서 강제한다(0.5.2 scope 하드가드와 동일 철학).
 * ⚠️ CODE_FILE_RE whitelist의 부정형(!CODE_FILE_RE)을 쓰지 않는 이유: 미등재 코드 확장자
 * (.vue/.svelte/.sql/.sh 등)가 게이트를 통째로 우회하는 신규 구멍이 된다. 문서 확장자 blocklist만
 * 좁게 skip — 설정(.json/.yaml)은 계속 judge 1단계 소관(오판 실증이 문서에 집중, 표면 최소화).
 */
const DOC_FILE_RE = /\.(md|mdx|txt|rst|adoc)$/i;

/** 문서 파일 경로인가(게이트 judge 미호출 즉시-pass 대상). 순수 술어 — 최종 확장자만 본다. */
export function isDocFile(filePath: string): boolean {
  return DOC_FILE_RE.test(filePath);
}

/**
 * 차단 사유 메시지를 빌드한다. 두 차단 종류를 다르게 안내한다:
 * - specEmpty=true (시나리오 미지정): 에이전트가 요청에서 시나리오를 도출 → 사용자 검증 →
 *   'gbc spec add'로 등록 후 재시도하도록 지시한다(도출 루프 트리거). 자동 등록 금지.
 * - specEmpty=false (침묵 누락): 지금 다루거나 'gbc defer add'로 명시 미루도록 안내한다.
 */
export function buildBlockReason(verdict: Verdict, specEmpty: boolean, source: string): string {
  if (specEmpty) {
    return (
      `🐢 거북이 게이트 — ${verdict.reason}\n` +
      `→ [에이전트] 사용자 요청에서 의도·동작 시나리오를 도출해 사용자에게 제시·검증받은 뒤, ` +
      `승인된 케이스를 'gbc spec add "<케이스>"'로 등록하고 재시도하세요. ` +
      `사용자 승인 없이 자동 등록하지 마세요. (명세 소스: ${source})`
    );
  }
  const missingLine =
    verdict.missing.length > 0 ? `\n누락(침묵): ${verdict.missing.join(", ")}` : "";
  // 누락 케이스는 .gbc/pending-review.json에 기록돼 있어 'gbc gate review'로 번호 체크리스트
  // 일괄 분류(승인→spec / 미룸→defer)가 가능하다. 개별 처리(직접 구현·gbc defer add)도 유효.
  // defer 유도 조건화(0.5.5, RCA §4-⑤): defer는 "이 변경의 형제 케이스"를 미루는 채널이다.
  // 별도 작업단위·로드맵 항목까지 defer로 흡수하면 계획 문서와 이중 추적이 된다(결함A 증폭 경로).
  return (
    `🐢 거북이 게이트 — ${verdict.reason}${missingLine}\n` +
    `→ 누락 케이스를 'gbc gate review'로 한 번에 분류(승인→spec / 미룸→defer)하거나, 지금 이 변경에서 직접 다루세요.` +
    ` 개별로 미룰 거면 'gbc defer add "<케이스>"' — 단 defer 대상은 이 변경의 형제 케이스만, 별도 작업단위·로드맵 항목은 계획 문서에 두세요. (명세 소스: ${source})`
  );
}

/**
 * pass verdict를 작업단위 캐시(markGated)에 넣어도 되는가.
 * - fail-open(판정 실패 안전통과)은 제외 — 일시 장애가 작업단위 내내 게이트를 무력화하는 것을 막는다.
 * - 빈 명세(specEmpty)도 제외 — 빈-spec hash는 상수라 한번 캐시되면 영원히 무효화 안 됨
 *   (= 게이트 교차세션 영구 우회, 2026-06-22 진단·수정). 빈 명세는 항상 재판정해야 한다.
 */
export function shouldCacheVerdict(verdict: Verdict, specEmpty: boolean): boolean {
  return verdict.verdict === "pass" && !verdict.failOpen && !specEmpty;
}

// ===== GateDecision 디스크립터 =====

/** 판정 분기 종류(평탄화 금지 — passthrough≠bypass≠doc-skip, cached≠pass, fail-open≠pass). */
export type GateKind =
  | "passthrough"
  | "bypass"
  | "doc-skip"
  | "cached"
  | "pass"
  | "fail-open"
  | "block"
  | "block-repeat";

/**
 * 응답 채널(transport-neutral). emit-JSON 모양으로 굳히지 않는다 — stdin-emit 매퍼/SDK-반환 매퍼가 번역.
 * - exit-silent: 무출력 종료(passthrough·bypass — hookSpecificOutput·systemMessage 없음).
 * - exit-gate: 버전 안내 첨부 출구 경유(doc-skip·cached·pass=notice-only, block=permission 동반).
 * - emit-direct: 안내 미첨부 직접 emit(fail-open만 — 실패 고지 systemMessage와 안내를 섞지 않는 기존 동작).
 */
export type GateOutputMode = "exit-silent" | "exit-gate" | "emit-direct";

/** 도구 호출에 대한 의미수준 허가 신호(트랜스포트 무관). */
export interface GatePermission {
  decision: "allow" | "ask" | "deny";
  reason: string;
}

export interface GateOutput {
  mode: GateOutputMode;
  /** exit-gate(block)·emit-direct(fail-open)에서만. doc-skip/cached/pass(notice-only)는 undefined. */
  permission?: GatePermission;
  /** fail-open 고지(systemMessage) — 사용자에게 "게이트가 검사 못 했음"을 알린다. */
  userMessage?: string;
}

/** 호출부가 커밋할 부수효과 디스크립터. 없는 필드는 그 효과 없음. */
export interface GateEffects {
  /** bypass.log append(GBC_NO_GATE 우회 계측). */
  logBypass?: boolean;
  /** failopen.log append(판정 실패 안전통과 계측) — 사유 문자열. */
  logFailOpen?: string;
  /** 작업단위 pass 캐시(markGated) — shouldCacheVerdict 충족 시에만. */
  markGated?: { specHash: string; reason: string };
  /** scope 큐잉(축A/축B 사후판정 예약) — 코드파일 pass 편집. */
  enqueueScope?: { toolName: string; input: EditToolInput; editText: string; specHash: string };
  /** 침묵-누락 케이스를 pending-review에 기록(gbc gate review 회수용) — missing 있을 때만. */
  pendingReview?: PendingReview;
  /** 골든셋 캡처(opt-in, fail-open 제외). */
  goldenCapture?: GoldenCase;
}

/** evaluateGate 반환 — 판정 종류 + 응답 채널 + 커밋할 효과 + 계측 이벤트(없으면 미기록). */
export interface GateDecision {
  kind: GateKind;
  output: GateOutput;
  effects: GateEffects;
  /** events.jsonl 이벤트(passthrough는 undefined = 무계측). */
  event?: GateEvent;
}

/**
 * 게이트 판정 함수(judge) 주입 계약 — 모델 호출을 대체 가능하게.
 * cwd(0.10.0 A3b ST4): CLI 트랜스포트 spawn에 판정 대상 repo를 명시하기 위한 전달 통로 —
 * TUI가 여러 repo를 동시에 다룰 때 프로세스 cwd 상속으로 무관한 컨텍스트가 새는 걸 막는다.
 */
/**
 * opts 객체 형식(2026-08-07 RCA 후속 ST12) — evidenceContext(grep 근거 2단계 재판정)를 7번째
 * 위치인자로 붙이는 대신 opts로 리팩터했다(로드맵 결정: blast radius 유계 — 이 파일의 타입·
 * defaultGateDeps·호출부 + 테스트 fake deps뿐, gate-sdk.ts는 deps를 직접 안 구성해 무영향).
 */
export type JudgeFn = (
  planSpec: string,
  editText: string,
  defers: string[],
  resolved: string[],
  opts?: { currentFileContent?: string; cwd?: string; evidenceContext?: string; editOldStrings?: string[] },
) => Promise<Verdict>;

/** evaluateGate 입력(트랜스포트가 자기 형식에서 정규화해 전달). */
export interface GateInput {
  toolName: string;
  toolInput: EditToolInput;
  cwd: string;
  session: string;
  /** 미지정 시 process.env(GBC_NO_GATE·GBC_BLOCK_MODE 판독). */
  env?: Record<string, string | undefined>;
}

/**
 * evaluateGate 의존성 — I/O·모델을 하는 것만 주입(순수 술어 isGatedTool·isDocFile·computeSpecHash·
 * normalizeEdit는 직접 import). refreshDuringJudge는 버전캐시 병렬 refresh seam(a): judge 직전 발화·
 * 직후 await → cached/doc-skip 경로엔 절대 안 실려 0.2.7(비-judge 경로 네트워크 금지) 보존.
 */
export interface GateDeps {
  judge: JudgeFn;
  loadPlanSpec: (cwd: string) => { text: string; source: string; warning?: string };
  isGated: (cwd: string, specHash: string) => boolean;
  isGoldenCapture: (cwd: string) => boolean;
  activeDeferItems: (cwd: string) => string[];
  resolvedDeferItems: (cwd: string) => string[];
  /** judge와 병렬로 도는 버전캐시 refresh 발화(선택). undefined면 refresh 안 함. */
  refreshDuringJudge?: () => Promise<void>;
  /** 직전 block이 남긴 펜딩-검토 레코드(0.9.3 ST2 — 동일 missing 셋 재발화 판별용). 없으면 null. */
  readPendingReview: (cwd: string) => PendingReview | null;
  /**
   * 편집 대상 파일의 현재(편집 전) 내용(0.9.3 ST3 — judge가 diff만으로 못 보는 기구현 형제 케이스를
   * 판별하게 함). 신규 파일·읽기 실패는 null(판정에서 [현재 파일 상태] 섹션 생략).
   */
  readCurrentFile: (filePath: string) => string | null;
  /**
   * block 판정의 missing 케이스별 grep 근거 수집(2026-08-07 RCA 후속 ST12, P2b — 이 배치의 유일한
   * 판정 로직 변경). deps로 주입해 evaluateGate를 grep/judge 재호출 없이 결정론 테스트 가능하게 한다
   * (judge/readCurrentFile과 동일 원칙).
   */
  collectCaseEvidence: (
    cwd: string,
    missing: string[],
    deletion?: DeletionScope | null,
  ) => Promise<CaseEvidence[]>;
}

/**
 * 읽기 상한(바이트) — judge.ts의 MAX_CURRENT_FILE(8000자)가 어차피 절단하므로 그보다 훨씬
 * 넉넉하되(정상 소스 파일은 다 통과) 병적으로 큰 파일을 hot path에서 동기 전체 로드하는 것만
 * 막는다(security-auditor 지적 — PreToolUse가 파일 크기 사전 확인 없이 동기 readFileSync).
 */
const MAX_READ_BYTES = 1_000_000;

/**
 * judge.ts MAX_CURRENT_FILE과 값이 같아야 하는 계측 임계값(2026-08-07, RCA 후속 fileBytes/truncated
 * 계측용). 정적 재import 대신 값 복제 — gate-core.ts가 judge.ts를 정적 import하면 deps 주입 테스트
 * 격리(파일 헤더 주석, judge=deps.judge로만 주입되는 이유)가 깨진다. 드리프트는
 * test/gate-core.test.mjs가 judge.js의 실export(MAX_CURRENT_FILE)와 값 동일성을 잠가 방지한다.
 */
export const CURRENT_FILE_TRUNCATION_LIMIT = 8000;

/**
 * 골든셋에 **영속 저장**할 파일 내용의 정규화(0.12.0 ship 전 security-auditor 후속).
 *
 * ⓐ `redactSecrets` — 전송(transient)과 디스크 영속(at-rest)은 노출면이 다르다. 같은 릴리스가
 *    추가한 형제 필드 `evidenceContext`는 조립 시점에 마스킹을 거치므로(evidence.ts
 *    formatEvidenceContext) 이쪽만 원문으로 남길 근거가 없다.
 * ⓑ `CURRENT_FILE_TRUNCATION_LIMIT` 절단 — replay가 이 값을 judge에 넘기면 `buildUserMessage`가
 *    어차피 같은 상한으로 자른다. 즉 그 뒤는 재현 충실도에 **기여할 수 없는** 죽은 용량인데,
 *    골든셋은 events.jsonl·extraction.jsonl과 달리 크기 상한도 로테이션도 없어 케이스마다 최대
 *    1MB(MAX_READ_BYTES)가 무한 누적됐다. 절단본을 저장해야 replay가 캡처 당시 judge가 본 것과
 *    바이트 동일해진다는 점에서 정확도와도 같은 방향이다.
 */
function forGoldenStorage(text: string): string {
  return redactSecrets(text).slice(0, CURRENT_FILE_TRUNCATION_LIMIT);
}

/**
 * 편집 대상 파일의 현재 내용을 읽는다(0.9.3 ST3, security-auditor 보강). PreToolUse는 편집이
 * *적용되기 전*에 실행되므로, file_path가 프로젝트 밖 임의 파일(예: 심링크로 위장된 ~/.ssh/id_rsa)을
 * 가리켜도 이 함수가 그 내용을 읽어 judge 프롬프트로(→ 외부 API) 실어보낼 위험이 있다 — spec.ts
 * resolveSpecText·verify.ts와 동일한 관례로 심링크를 거부한다. 크기 상한 초과도 null(스킵) —
 * 둘 다 "실패로 보이지 않게" null 반환해 [현재 파일 상태] 섹션이 조용히 생략되게 한다(기존 계약:
 * null=신규 파일/조회 실패와 동일하게 다뤄짐, 게이트 판정 자체를 막지 않는다).
 */
export function readCurrentFile(filePath: string): string | null {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) return null; // 심링크 거부 — 임의 파일 읽기 차단
    if (!st.isFile()) return null; // 디렉토리 등은 대상 아님
    if (st.size > MAX_READ_BYTES) return null; // 병적 대용량 — hot path 동기 전체로드 방지
    return readFileSync(filePath, "utf8");
  } catch {
    return null; // 신규 파일(아직 생성 전)이거나 읽기 실패 — [현재 파일 상태] 섹션 생략으로 흡수
  }
}

/**
 * 프로덕션 의존성 배선. judge는 dynamic import로 감싼다.
 *
 * ⚠️ 근거 정정(0.12.0 F-16) — 예전 주석은 이것을 "핫패스 zero-dep 보존"이라고 설명했으나 **사실이
 * 아니다**: `package.json`의 bin은 `dist/cli.js` 단일 진입점이고 `cli.ts`가 `judge.js`를 정적
 * import하므로(`selectedTransport`·`judgeM1Violation`), ESM 의미론상 `gbc hook pre-tool-use`를
 * 포함한 **모든** 서브커맨드에서 judge.js는 argv 디스패치 전에 이미 평가된다 — `await import`은
 * 모듈 캐시 히트일 뿐이다. 게다가 judge.ts 최상위는 node 코어 모듈만 쓰고 `@anthropic-ai/sdk`는
 * `createApiClient` 안에서 따로 동적 import된다.
 *
 * 남아 있는 **실익은 단위테스트 격리** 하나다: gate-core.test.mjs가 judge.js를 끌어오지 않고
 * 분기 로직만 결정론으로 검증할 수 있다. 그 이유로 유지한다.
 */
export function defaultGateDeps(refreshDuringJudge?: () => Promise<void>): GateDeps {
  return {
    judge: async (spec, edit, defers, resolved, opts) =>
      (await import("./judge.js")).judge(spec, edit, defers, resolved, opts),
    loadPlanSpec,
    isGated,
    isGoldenCapture,
    activeDeferItems,
    resolvedDeferItems,
    refreshDuringJudge,
    readPendingReview,
    readCurrentFile,
    collectCaseEvidence: (cwd, missing, deletion) => collectCaseEvidence(cwd, missing, { deletion }),
  };
}

/**
 * 게이트 판정 코어(순수 오케스트레이션 + 효과 디스크립터). process.exit·emit·파일쓰기 없음.
 * infra throw(loadPlanSpec·isGated 디스크 실패)는 밖으로 던진다 — 호출부가 자기 경계로 감싼다
 * (stdin=runHookSafely, SDK=ST4 정형채널). judge 자체 실패는 judge 내부가 failOpenVerdict로 흡수.
 * preToolUseBody(hook.ts) 판정 흐름의 behavior-preserving 이식 — 분기·부수효과·계측이 1:1 대응한다.
 */
export async function evaluateGate(input: GateInput, deps: GateDeps): Promise<GateDecision> {
  const env = input.env ?? process.env;
  const toolName = input.toolName ?? "";
  const { cwd } = input;
  const session = input.session ?? "";

  // ① 코드 변경 도구가 아니면 즉시 통과 — 무출력·무계측(passthrough).
  if (!isGatedTool(toolName)) {
    return { kind: "passthrough", output: { mode: "exit-silent" }, effects: {} };
  }

  // ② 명시적 우회(GBC_NO_GATE=1) — 계측만 남기고 통과.
  if (env.GBC_NO_GATE === "1") {
    return {
      kind: "bypass",
      output: { mode: "exit-silent" },
      effects: { logBypass: true },
      event: { at: nowIso(), session, specHash: "", kind: "bypass", tool: toolName },
    };
  }

  // ③ 문서 하드가드(0.5.5) — 문서 확장자는 judge 미호출 즉시 pass. spec 로드 전 초입이라 specHash="".
  if (isDocFile(input.toolInput?.file_path ?? "")) {
    return {
      kind: "doc-skip",
      output: { mode: "exit-gate" },
      effects: {},
      event: { at: nowIso(), session, specHash: "", kind: "gate", tool: toolName, decision: "doc-skip" },
    };
  }

  const { text: specText, source } = deps.loadPlanSpec(cwd);
  const specHash = computeSpecHash(specText);
  const specEmpty = specText.trim() === "";
  // 계측용 해시: 빈 spec은 ""(센티넬)로 기록 → M1 churn 교차세션 합산 방지.
  const logHash = specEmpty ? "" : specHash;

  // ④ 작업단위 1회 캐시 — 빈 명세는 절대 조회하지 않는다(상수 hash 영구우회 방지, read-side 가드).
  if (!specEmpty && deps.isGated(cwd, specHash)) {
    return {
      kind: "cached",
      output: { mode: "exit-gate" },
      effects: {},
      event: { at: nowIso(), session, specHash: logHash, kind: "gate", tool: toolName, decision: "cached" },
    };
  }

  // ⑤ judge 호출(모델). 버전캐시 refresh는 judge와 *병렬*로만(seam a) — judge 직전 발화·직후 await.
  //    cached/doc-skip 경로엔 여기 도달 못 하므로 네트워크가 절대 안 실린다(0.2.7 보존).
  const editText = normalizeEdit(toolName, input.toolInput ?? {});
  const defers = deps.activeDeferItems(cwd);
  const resolved = deps.resolvedDeferItems(cwd);
  // 0.9.3 ST3 — 편집 대상 파일의 현재 내용을 judge에 함께 전달(diff만으로 못 보는 기구현 형제 판별용).
  const filePath = input.toolInput?.file_path;
  const currentFileContent = filePath ? deps.readCurrentFile(filePath) ?? undefined : undefined;
  // fileBytes/truncated(2026-08-07 RCA 후속) — judge에 실제 실린 [현재 파일 상태] 원문 크기·절단
  // 여부를 이벤트에 남긴다(경로·본문은 넣지 않음). currentFileContent 자체가 없으면(신규 파일 등)
  // 둘 다 undefined — "0바이트"로 뻥튀기하지 않는다.
  const fileBytes = currentFileContent !== undefined ? Buffer.byteLength(currentFileContent, "utf8") : undefined;
  const truncated = fileBytes !== undefined ? fileBytes > CURRENT_FILE_TRUNCATION_LIMIT : undefined;
  const refreshP = deps.refreshDuringJudge ? deps.refreshDuringJudge() : null;
  // let: P2b 근거주입 2단계 재판정(아래 ⑥-2)이 성공하면 이 변수를 재판정 결과로 교체한다.
  let verdict = await deps.judge(specText, editText, defers, resolved, { currentFileContent, cwd });
  if (refreshP) await refreshP; // judge 동안 이미 완료 — 이 편집의 notice가 갱신된 캐시를 읽도록
  // fileBytes 없음(신규 파일 등)이면 키 자체를 생략 — undefined로 채워 넣지 않는다(기존 tool?:string
  // 등 선택필드 관례와 동일, "0바이트"로 오독될 여지 차단).
  const fileMeta = fileBytes !== undefined ? { fileBytes, truncated } : {};

  const effects: GateEffects = {};

  // ⑥ 골든셋 캡처(opt-in) — judge가 실제 평가한 cache-miss edit만, fail-open 제외(실판정 아님).
  if (!verdict.failOpen && deps.isGoldenCapture(cwd)) {
    effects.goldenCapture = {
      id: goldenCaseId(toolName, editText, specText),
      at: nowIso(),
      tool: toolName,
      edit: editText,
      spec: specText,
      defers,
      resolved,
      // 2026-08-07 RCA 후속 — 캡처 시점 judge에 실린 [현재 파일 상태]를 함께 저장한다. 없으면
      // (신규 파일 등) 키 자체 생략(undefined로 채우지 않음, fileMeta와 동일 관례).
      // 저장 형태는 `forGoldenStorage`를 거친다(types.ts GoldenCase.currentFileContent 참조) —
      // 위 fileBytes/truncated 계측은 **절단 이전 원본**을 재는 별개 축이라 영향받지 않는다.
      ...(currentFileContent !== undefined ? { currentFileContent: forGoldenStorage(currentFileContent) } : {}),
      expected: { verdict: verdict.verdict, missing: verdict.missing, reason: verdict.reason },
    };
  }

  // ⑥-2 P2b 근거주입 2단계 재판정(2026-08-07 RCA 후속 ST12 — 이 배치의 유일한 판정 로직 변경).
  // 8000바이트 절단면 뒤쪽·타 파일에 이미 구현된 형제 케이스를 창 위치 추측이 아니라 grep 실측
  // 근거로 확인한다. 골든 캡처(⑥) *이후*에 두는 이유 — 회귀락은 1차 judge 원본 판정을 그대로
  // 잠가야 한다(재판정으로 캡처가 오염되면 드리프트 감지 기준 자체가 흔들린다).
  let evidenceUsed = false;
  let evidenceFlip = false;
  let evidenceBudgetExhausted = false;
  let evidenceDropped = 0;
  let evidenceFailed = false;
  let evidenceBudgetReason: "count" | "time" | undefined;
  if (verdict.verdict === "block" && verdict.missing.length > 0 && !isOverwriteEdit(toolName, input.toolInput ?? {})) {
    // ① Write 억제 필수(위 조건에 이미 반영) — 근거는 *편집 전* 파일을 grep하므로, Write에서
    // "존재함"을 보고하면 GATE_SYSTEM ★★ 규칙(덮어쓰기로 삭제되는 회귀는 여전히 missing)과 정면
    // 충돌해 정답인 block을 pass로 논증하게 된다.
    // F-8 — 이번 편집이 *지우는* self-file 줄은 근거에서 뺀다(Write 억제와 대칭인 Edit/MultiEdit
    // 축). 편집 전 파일을 grep하는 구조상, 케이스 구현을 삭제하는 Edit이 자기가 지울 코드를
    // "이미 구현됨"으로 인용해 정답인 block을 pass로 뒤집는 경로가 열려 있었다.
    const editList = input.toolInput?.edits
      ?? (input.toolInput?.old_string ? [{ old_string: input.toolInput.old_string, new_string: input.toolInput.new_string }] : []);
    const deletion: DeletionScope | null =
      filePath && currentFileContent !== undefined
        ? computeDeletionScope(cwd, filePath, currentFileContent, editList)
        : null;
    // ④ 수집 단계 예외는 **여기서 흡수**한다(0.12.0 F-10). collectCaseEvidence는 grep 실행·경로
    // 처리 등 I/O를 하는데, 여기서 throw가 새면 evaluateGate 밖으로 올라가 runHookSafely가 "훅
    // 자체 실패"로 흡수해 **편집을 허용**한다 — 오탐을 줄이려는 기능의 실패가 게이트를 통째로 여는
    // 경로다. 재판정 실패를 try/catch로 감싸면 안 되는 것(위 ②)과 모순이 아니다: judge는 절대
    // throw하지 않아 catch가 영영 안 도는 반면, 수집기는 실제로 throw할 수 있고 그 실패의 올바른
    // 귀결은 "근거 없음 = 원래 block 유지"로 정해져 있다.
    let evidenceList: CaseEvidence[] = [];
    try {
      evidenceList = await deps.collectCaseEvidence(cwd, verdict.missing, deletion);
    } catch {
      evidenceFailed = true; // 조용히 삼키지 않는다 — 아래 이벤트에 남겨 "한 번도 안 돌았음"과 구분
    }
    // 예산 소진은 재판정 발화 여부와 **무관하게** 기록한다(0.12.0 F-14) — 매치 0으로 block을 유지한
    // 판정이 "근거가 없어서"인지 "예산이 모자라 못 봐서"인지가 바로 그 경우에 가장 알고 싶은 정보다.
    evidenceBudgetExhausted = evidenceList.some((e) => e.budgetSkipped);
    // 사유(개수/시간)까지 남긴다 — 해소법이 다르다(개수=상한/케이스 수 문제, 시간=repo·grep 속도).
    // 첫 스킵 사유를 대표값으로 쓴다: 둘이 섞이면 먼저 걸린 쪽이 실질 병목이다.
    evidenceBudgetReason = evidenceList.find((e) => e.budgetSkipReason)?.budgetSkipReason;
    const matched = evidenceList.filter((e) => e.matched);
    // ③ 매치 0(= matched 공집합)이면 재판정 자체를 생략한다 — 근거 없이 재호출해봐야 답이 바뀔 수
    // 없고, CLI 폴백은 호출 2회면 최대 60s까지 늘어난다(judge.ts CLI_TIMEOUT_MS 30s 참조).
    if (matched.length > 0) {
      evidenceUsed = true;
      // 총량 캡(0.12.0 F-9) — 케이스별로는 formatGrepContext가 4000자로 잘라주지만 합계엔 상한이
      // 없어 missing 건수에 비례해 무한정 커졌다. 조립·절단은 evidence.ts의 순수함수가 맡는다.
      // dropped는 이벤트에도 남긴다(F-14와 같은 원칙: 무엇을 못 봤는지가 프롬프트 텍스트에만
      // 있으면 사후에 "근거가 없었다"와 "근거를 잘랐다"를 구분할 수 없다).
      const assembled = formatEvidenceContext(matched);
      evidenceDropped = assembled.dropped;
      const evidenceContext = assembled.text;
      const verdict2 = await deps.judge(specText, editText, defers, resolved, {
        currentFileContent,
        cwd,
        evidenceContext,
      });
      // ② fail-open은 값검사(try/catch 아님) — judge()는 절대 throw하지 않고 모든 실패를
      // failOpenVerdict로 흡수한다. verdict2.failOpen이면 재판정 자체를 신뢰 못 하므로 폐기하고
      // 원래 block(verdict)을 그대로 유지한다 — 이걸 try/catch로 감싸면 catch가 영영 안 돌아
      // "정당한 block 자리에 fail-open pass가 조용히 들어앉는" 사고가 난다(호출 2회라 확률도 2배).
      if (!verdict2.failOpen) {
        // 집합 비교(0.12.0 F-3) — 길이 비교였을 땐 "개수는 같고 내용만 바뀐" 교체가 flip=false로
        // 기록됐다. P2b가 오탐을 얼마나 해소했는지 증명해야 할 지표가 스스로를 과소집계하던 결함.
        // ⑧의 block-repeat 판정이 쓰는 것과 **같은** sameMissingSet을 재사용한다(정규화 후 정렬
        // 비교라 순서 차이는 flip이 아님) — 두 곳이 "같은 missing인가"를 다르게 답하면 안 된다.
        evidenceFlip = verdict2.verdict !== verdict.verdict || !sameMissingSet(verdict2.missing, verdict.missing);
        // 골든에 2단계를 후첨(0.12.0 F-13) — ⑥의 expected(1차 판정)는 **그대로 두고** 근거 원문과
        // 재판정 결과만 덧붙인다. 이래야 replay가 P2b까지 재현해 드리프트를 볼 수 있으면서도,
        // 1차 판정 회귀락은 재판정에 오염되지 않는다. fail-open 재판정은 여기 도달하지 않으므로
        // 신뢰 못 하는 결과가 기준으로 굳는 일도 없다.
        if (effects.goldenCapture) {
          effects.goldenCapture.evidenceContext = evidenceContext;
          effects.goldenCapture.expectedAfterEvidence = {
            verdict: verdict2.verdict,
            missing: verdict2.missing,
            reason: verdict2.reason,
          };
        }
        verdict = verdict2;
      }
    }
  }
  // evidenceUsed/evidenceFlip 없으면(재판정 자체가 없었으면) 키 생략 — 다른 계측 필드와 동일 관례.
  // evidenceBudgetExhausted는 재판정 유무와 독립적으로 붙는다(위 F-14 주석 참조).
  const evidenceMeta = {
    ...(evidenceUsed ? { evidenceUsed, evidenceFlip } : {}),
    ...(evidenceBudgetExhausted ? { evidenceBudgetExhausted } : {}),
    ...(evidenceBudgetReason ? { evidenceBudgetReason } : {}),
    ...(evidenceDropped > 0 ? { evidenceDropped } : {}),
    ...(evidenceFailed ? { evidenceFailed } : {}),
  };

  // ⑦ pass 분기 — fail-open(판정 실패)을 먼저 분기(빈-spec 정상 pass 오분류 방지). verdict가 위
  // 재판정으로 교체됐을 수 있다 — 근거주입이 missing을 전부 해소하면 여기서 pass로 처리된다.
  if (verdict.verdict === "pass") {
    if (verdict.failOpen) {
      // 판정 실패로 안전 통과. 캐시·큐잉하지 않고(작업단위 무력화 방지) notice 미첨부 직접 emit로 고지.
      return {
        kind: "fail-open",
        output: {
          mode: "emit-direct",
          permission: { decision: "allow", reason: verdict.reason },
          userMessage: `🐢 거북이 게이트 — 판정 실패로 안전 통과(fail-open). 이 편집은 게이트 검사를 받지 못했습니다: ${verdict.reason}`,
        },
        effects: { ...effects, logFailOpen: verdict.reason },
        event: { at: nowIso(), session, specHash: logHash, kind: "gate", tool: toolName, decision: "failopen", ...fileMeta },
      };
    }
    // 정상 pass. 단 빈 명세 pass는 절대 캐시하지 않는다(상수 hash 영구 우회 방지).
    if (shouldCacheVerdict(verdict, specEmpty)) effects.markGated = { specHash, reason: verdict.reason };
    // scope 큐잉(축A/축B) — 판정된 pass 편집을 Stop서 파급반경·사다리 판정하도록 예약(코드파일 가드는 커밋부).
    effects.enqueueScope = { toolName, input: input.toolInput ?? {}, editText, specHash: logHash };
    return {
      kind: "pass",
      output: { mode: "exit-gate" },
      effects,
      event: {
        at: nowIso(), session, specHash: logHash, kind: "gate", tool: toolName,
        decision: "pass", deferCount: defers.length, ...fileMeta, ...evidenceMeta,
      },
    };
  }

  // ⑧ block: 사람 pause(ask 기본, GBC_BLOCK_MODE=deny면 deny). 사유가 사용자에게 표시된다.
  const reason = buildBlockReason(verdict, specEmpty, source);
  // 침묵-누락 케이스(missing[])를 펜딩-검토에 기록 → 'gbc gate review'가 번호 체크리스트로 회수.
  if (verdict.missing.length > 0) {
    // 0.9.3 ST2 — 같은 작업단위(specHash)에서 이미 펜딩-검토에 기록된 missing 셋과 (정규화 후)
    // 동일하면 재발화로 본다(fa-support 도그푸딩 리포트: 순차 파이프라인에서 아직 안 다룬 후속
    // SubTask가 매 편집마다 같은 문구로 재차단되던 노이즈). specEmpty는 대상 아님(그쪽은 ST1의
    // walk-up이 근본원인) — 여긴 missing[] 기반 침묵-누락 반복만 다룬다.
    const prior = deps.readPendingReview(cwd);
    const isRepeat = !specEmpty && prior?.specHash === specHash && sameMissingSet(prior.missing, verdict.missing);
    effects.pendingReview = { missing: verdict.missing, reason: verdict.reason, source, at: nowIso(), specHash: logHash };
    if (isRepeat) {
      return {
        kind: "block-repeat",
        output: {
          mode: "emit-direct",
          userMessage:
            `🐢 거북이 게이트 — 같은 누락 케이스가 이미 안내됐습니다(재알림 생략): ${verdict.reason}\n` +
            `→ 'gbc gate review'로 분류하거나 지금 다루세요.`,
        },
        effects,
        event: {
          at: nowIso(), session, specHash: logHash, kind: "gate", tool: toolName,
          decision: "block-repeat", missing: verdict.missing, deferCount: defers.length, ...fileMeta, ...evidenceMeta,
        },
      };
    }
  }
  const mode = env.GBC_BLOCK_MODE === "deny" ? "deny" : "ask";
  return {
    kind: "block",
    output: { mode: "exit-gate", permission: { decision: mode, reason } },
    effects,
    event: {
      at: nowIso(), session, specHash: logHash, kind: "gate", tool: toolName,
      decision: "block", missing: verdict.missing, deferCount: defers.length, ...fileMeta, ...evidenceMeta,
    },
  };
}

/** missing 셋 동일성 비교(순서 무관, 정규화 후) — 재발화 판별용(0.9.3 ST2). */
function sameMissingSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const na = a.map(normalizeCase).sort();
  const nb = b.map(normalizeCase).sort();
  return na.every((v, i) => v === nb[i]);
}
