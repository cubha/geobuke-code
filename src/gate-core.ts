// PreToolUse 게이트 판정의 transport-neutral 코어 (0.7.0 A1 ST1).
// preToolUseBody(hook.ts)에서 추출 — 부수효과를 *커밋하지 않고* GateDecision 디스크립터로 반환한다.
// 호출부(stdin hook / SDK 콜백)가 effects를 커밋하고 output.mode에 따라 도구 호출에 응답한다.
// judge는 JudgeFn으로 주입 → 모델 없이 분기 결정론 단위 테스트 가능(이 추출의 회귀락 = ST4 SDK 회귀락).
// 이 파일은 hook.ts를 import하지 않는다(단방향: hook.ts → gate-core.ts). SDK/@anthropic은 judge 안에서만
// lazy import되고, defaultGateDeps가 judge를 lazy dynamic import로 감싸 핫패스 zero-dep을 보존한다.
import { normalizeEdit, isGatedTool } from "./normalize.js";
import { loadPlanSpec, computeSpecHash } from "./spec.js";
import { isGated } from "./state.js";
import { isGoldenCapture } from "./config.js";
import { activeDeferItems, resolvedDeferItems } from "./defer.js";
import { goldenCaseId } from "./golden.js";
import { nowIso } from "./time.js";
import type { EditToolInput, Verdict, GoldenCase } from "./types.js";
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
export type GateKind = "passthrough" | "bypass" | "doc-skip" | "cached" | "pass" | "fail-open" | "block";

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
  pendingReview?: { missing: string[]; reason: string; source: string; at: string };
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

/** 게이트 판정 함수(judge) 주입 계약 — 모델 호출을 대체 가능하게. */
export type JudgeFn = (
  planSpec: string,
  editText: string,
  defers: string[],
  resolved: string[],
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
}

/**
 * 프로덕션 의존성 배선. judge를 lazy dynamic import로 감싸 핫패스 zero-dep 보존
 * (deps.judge는 cache-miss 경로에서만 호출되므로 import도 그때만 발화 = 기존 hook의 lazy import 동등).
 */
export function defaultGateDeps(refreshDuringJudge?: () => Promise<void>): GateDeps {
  return {
    judge: async (spec, edit, defers, resolved) =>
      (await import("./judge.js")).judge(spec, edit, defers, resolved),
    loadPlanSpec,
    isGated,
    isGoldenCapture,
    activeDeferItems,
    resolvedDeferItems,
    refreshDuringJudge,
  };
}

/**
 * 게이트 판정 코어(순수 오케스트레이션 + 효과 디스크립터). process.exit·emit·파일쓰기 없음.
 * infra throw(loadPlanSpec·isGated 디스크 실패)는 밖으로 던진다 — 호출부가 자기 경계로 감싼다
 * (stdin=runHookSafely, SDK=ST4 정형채널). judge 자체 실패는 judge 내부가 failOpenVerdict로 흡수.
 * STUB(ST1 RED) — 구현은 preToolUseBody(hook.ts) 판정 흐름의 behavior-preserving 이식.
 */
export async function evaluateGate(_input: GateInput, _deps: GateDeps): Promise<GateDecision> {
  throw new Error("evaluateGate: not implemented (ST1 RED)");
}
