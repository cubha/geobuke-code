// PreToolUse / Stop hook 핸들러.
// 핫패스 보호: 이 파일은 SDK를 import하지 않는다. judge.ts가 API 호출 시에만 lazy import.
// "이미 게이트됨 → exit 0"은 상태파일만 읽고 즉시 종료(judge 미호출).
import { isGatedTool, normalizeEdit } from "./normalize.js";
import { loadPlanSpec, computeSpecHash } from "./spec.js";
import { isGated, markGated } from "./state.js";
import { activeDeferItems, resolvedDeferItems, unresolvedDefers, loadDefers, isClosedStatus } from "./defer.js";
import { isStopHintMuted, isGoldenCapture } from "./config.js";
import { loadRepos } from "./repos.js";
import { writePendingReview } from "./review.js";
import { addGoldenCase, goldenCaseId } from "./golden.js";
import { enqueueScope, readScopeQueue, clearScopeQueue, collectGrepContext, enrichVerdictsWithSpecHash } from "./scope.js";
import { readProjectSettings, buildUpdateNotice, wasNotified, markNotified } from "./notice.js";
import {
  isCacheStale,
  readVersionCache,
  refreshVersionCache,
  shouldRefreshCache,
} from "./version.js";
import { appendFileSync, existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { gbcDir } from "./store.js";
import { logEvent } from "./metrics.js";
import type { EditToolInput, Verdict, DeferEntry, ScopeVerdict } from "./types.js";

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

interface PreToolUseInput {
  tool_name?: string;
  tool_input?: EditToolInput;
  cwd?: string;
  permission_mode?: string;
  session_id?: string;
}

interface StopInput {
  cwd?: string;
  stop_hook_active?: boolean;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    // stdin이 비어있는 경우 대비
    if (process.stdin.isTTY) resolve("");
  });
}

/**
 * hook stdin 입력 파싱(순수, 0.6.1 F1) — 3핸들러에 복붙돼 있던 "파싱 실패→안전 통과" 불변식의
 * 단일 소스. 빈 입력={}(입력 없음으로 통과), 파싱 실패=null(호출자가 즉시 exit 0 fail-open).
 * valid-JSON 비객체(null·숫자·문자열)도 {}로 — 종전엔 JSON.parse("null")이 input에 그대로 실려
 * 속성 접근 TypeError→exit1 비정형 fail-open으로 샜다(빈 입력과 동일 취급이 불변식에 정합).
 */
export function parseHookInput<T>(raw: string): T | null {
  if (!raw) return {} as T;
  try {
    const v = JSON.parse(raw) as unknown;
    return (typeof v === "object" && v !== null ? v : {}) as T;
  } catch {
    return null;
  }
}

/**
 * 훅 공통 정형 fail-open 경계(0.6.1 R7 설계결정). store.ts 원시 I/O(gbcDir mkdir·writeJson)는
 * 의도적으로 계속 throw한다 — CLI 경로('gbc spec add' 등)는 디스크 실패를 성공처럼 삼키면 안 된다.
 * 훅 경로만 이 경계가 흡수: 종전 uncaught→main().catch exit 1은 PreToolUse 계약상 비차단이라
 * fail-open이긴 했지만 failopen.log·고지·계측이 전부 빠진 *비정형*이었다. 여기서 정형화
 * (best-effort 계측 + systemMessage 고지 + exit 0). A-mode in-process 전환 시 이 경계가
 * 콜백 예외 정책으로 1:1 치환되는 seam이다.
 */
async function runHookSafely(
  kind: string,
  body: (onCwd: (cwd: string) => void) => Promise<void>,
): Promise<void> {
  // body가 input에서 확정한 cwd를 되돌려 받는다(onCwd) — catch의 failopen.log가 process.cwd()가
  // 아니라 실제 대상 프로젝트 .gbc/에 남게(input.cwd || process.cwd() 컨벤션 정합, scope-critic ②b).
  let cwd = process.cwd();
  try {
    await body((c) => (cwd = c));
  } catch (e) {
    try {
      logFailOpen(cwd, kind, String(e).slice(0, 160));
    } catch {
      /* 계측 실패는 무시 — fail-open 자체를 막지 않는다 */
    }
    emit({
      systemMessage: `🐢 거북이 게이트 — 내부 오류로 검사 없이 안전 통과(fail-open): ${String(e).slice(0, 120)}`,
    });
    process.exit(0);
  }
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

function logBypass(cwd: string, toolName: string): void {
  try {
    appendFileSync(join(gbcDir(cwd), "bypass.log"), `${new Date().toISOString()} ${toolName}\n`);
  } catch {
    /* 계측 실패는 무시 */
  }
}

/** fail-open(판정 실패 안전통과) 계측 — 게이트가 무력화된 편집을 사후 추적할 수 있게 한다. */
function logFailOpen(cwd: string, toolName: string, reason: string): void {
  try {
    appendFileSync(
      join(gbcDir(cwd), "failopen.log"),
      `${new Date().toISOString()} ${toolName} ${reason}\n`,
    );
  } catch {
    /* 계측 실패는 무시 */
  }
}

/** hook 컨텍스트 — cli.ts가 설치 경로·현재 버전을 주입(업데이트 안내용). */
export interface HookContext {
  cliPath?: string;
  version?: string;
}

/**
 * 업데이트 안내 문자열(세션당 1회). 안내는 게이트와 완전 독립 — 어떤 실패도 게이트 결정에
 * 영향 주지 않게 전체를 try/catch로 감싼다(fail-silent). cliPath 없으면(직접 hook 호출 등) "".
 */
function maybeUpdateNotice(cwd: string, session: string, ctx?: HookContext): string {
  try {
    if (!ctx?.cliPath) return "";
    if (wasNotified(cwd, session)) return "";
    const notice = buildUpdateNotice(readProjectSettings(cwd), ctx.cliPath, ctx.version ?? "");
    if (notice) markNotified(cwd, session);
    return notice;
  } catch {
    return "";
  }
}

/** 코드 파일 확장자(scope 큐잉 대상 — 문서/설정 편집은 파급반경·사다리 판정 대상 아님). */
const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cpp|cc|cs|kt|swift|scala)$/i;

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
 * pass한 동작편집을 scope 큐(.gbc/scope-queue.json)에 넣는다 — Stop 훅이 그 턴 종료 시 실제 grep으로
 * 축A/축B 판정. hot path엔 API·grep 없음(정규화+파일 append만). GBC_NO_SCOPE=1이면 전체 스킵.
 * fail-silent: 큐잉 실패는 게이트를 절대 막지 않는다. 코드파일 편집만(문서/설정 제외).
 */
function maybeEnqueueScope(
  cwd: string,
  toolName: string,
  input: EditToolInput,
  editText: string,
  specHash: string,
): void {
  if (process.env.GBC_NO_SCOPE === "1") return;
  try {
    const file = input.file_path ?? "";
    if (!file || !CODE_FILE_RE.test(file)) return;
    enqueueScope(cwd, { file, tool: toolName, edit: editText, specHash, at: nowIso() });
  } catch {
    /* 큐잉 실패는 무시(hot path 보호) */
  }
}

/** PreToolUse: 코드 변경 직전 게이트 — 정형 fail-open 경계(runHookSafely) 경유. */
export function runPreToolUse(ctx?: HookContext): Promise<void> {
  return runHookSafely("pre-tool-use", (onCwd) => preToolUseBody(ctx, onCwd));
}

async function preToolUseBody(ctx?: HookContext, onCwd?: (cwd: string) => void): Promise<void> {
  const input = parseHookInput<PreToolUseInput>(await readStdin());
  if (input === null) process.exit(0); // 입력 파싱 실패 → 안전하게 통과(fail-open)

  const toolName = input.tool_name ?? "";
  const cwd = input.cwd || process.cwd();
  onCwd?.(cwd);
  const session = input.session_id ?? "";

  // 코드 변경 도구가 아니면 즉시 통과
  if (!isGatedTool(toolName)) process.exit(0);

  // 명시적 우회 (계측됨)
  if (process.env.GBC_NO_GATE === "1") {
    logBypass(cwd, toolName);
    logEvent(cwd, { at: nowIso(), session, specHash: "", kind: "bypass", tool: toolName });
    process.exit(0);
  }

  // 문서 하드가드(0.5.5, 결함A) — 문서 확장자는 judge 미호출 즉시 pass. GATE_SYSTEM 1단계
  // "문서 → 무조건 pass"의 코드 강제(프롬프트 위반 3회 실증 근절). spec 로드 전 초입이라
  // specHash는 ""(M1 churn 자동 제외·M2는 block만. M3는 session 키라 기존 문서편집과 동일 참여).
  // 조용한 우회 방지 위해 doc-skip 계측.
  if (isDocFile(input.tool_input?.file_path ?? "")) {
    logEvent(cwd, { at: nowIso(), session, specHash: "", kind: "gate", tool: toolName, decision: "doc-skip" });
    const docNotice = maybeUpdateNotice(cwd, session, ctx);
    if (docNotice) emit({ systemMessage: docNotice });
    process.exit(0);
  }

  const { text: specText, source } = loadPlanSpec(cwd);
  const specHash = computeSpecHash(specText);
  const specEmpty = specText.trim() === "";
  // 계측용 해시: 빈 spec은 ""(센티넬)로 기록 → M1 churn 교차세션 합산 방지.
  const logHash = specEmpty ? "" : specHash;

  // 작업단위 1회: 이미 게이트 통과한 단위면 즉시 통과 (judge 미호출, 핫패스)
  // 계측: cached-skip도 기록해야 M3(작업단위당 edit 반복)이 진짜 횟수를 잡는다.
  // ⚠️ 빈 명세는 캐시를 절대 조회하지 않는다(read-side 가드) — 빈-spec hash는 상수라
  //    한번 캐시된 pass가 영원히 무효화되지 않아 게이트가 교차세션으로 영구 무력화되던
  //    결함(2026-06-22 진단)을 근본 차단. 빈 명세는 항상 재판정: judge [1단계] 사소한
  //    편집 pass, [2단계]a 동작 편집 block. (기존에 오염된 state.json도 자동으로 무시됨)
  if (!specEmpty && isGated(cwd, specHash)) {
    logEvent(cwd, {
      at: nowIso(),
      session,
      specHash: logHash,
      kind: "gate",
      tool: toolName,
      decision: "cached",
    });
    // 업데이트 안내(있으면)를 cached-skip에서도 노출 — 평상 작업은 대부분 통과된 작업단위라
    // 이 경로가 가장 흔하다. 여기서 빠지면 보이는 배너(PreToolUse systemMessage)가 거의 안 떴음
    // (0.2.x 가시성 갭). maybeUpdateNotice는 세션당 1회 dedup이라 노이즈 없음(매 세션 첫 편집 1회).
    // permissionDecision 없음 → cached-pass 통과 동작 불변. 네트워크 없음(캐시만 읽음).
    const cachedNotice = maybeUpdateNotice(cwd, session, ctx);
    if (cachedNotice) emit({ systemMessage: cachedNotice });
    process.exit(0);
  }

  // judge는 여기서만 동적 import (SDK lazy)
  const { judge } = await import("./judge.js");
  const editText = normalizeEdit(toolName, input.tool_input ?? {});
  const defers = activeDeferItems(cwd);
  // 완료된 케이스를 judge에 [이미 완료된 항목]으로 함께 전달 → 과거 작업단위의 resolved 케이스를
  // "미처리 형제"로 오인해 재차단하던 드리프트 완화(2026-06-26). active와 상호배타(filter 분리).
  const resolved = resolvedDeferItems(cwd);
  // ①신버전 캐시 자동 refresh(0.3.0) — 사용자가 'gbc status'를 안 쳐도 캐시가 최신이 되게.
  // judge(네트워크·≥1.5s)와 *병렬*로만 건다 → 핫패스 지연 0. cache-miss(여기 = judge 도는
  // 비-핫패스)에서만 stale일 때. cached-skip 핫패스엔 절대 네트워크 안 넣는다(0.2.7 원칙 보존).
  // refreshVersionCache는 내부 fail-silent(reject 불가)라 judge 경로를 깨지 않는다.
  const refreshP = shouldRefreshCache(Boolean(ctx?.cliPath)) ? refreshVersionCache() : null;
  const verdict = await judge(specText, editText, defers, resolved);
  if (refreshP) await refreshP; // judge 동안 이미 완료 — 이 편집의 notice가 갱신된 캐시를 읽도록

  // 골든셋 캡처(A2, opt-in) — judge가 실제 평가한 cache-miss edit만, fail-open 제외(실판정 아님).
  // editText(편집 본문)는 events.jsonl이 절대 저장 안 하는 내용 → 캡처는 .gbc/golden.json에 로컬만.
  // 캡처 실패는 게이트를 막지 않는다(fail-silent). cached-skip 경로는 위에서 이미 return돼 도달 안 함.
  if (!verdict.failOpen && isGoldenCapture(cwd)) {
    try {
      addGoldenCase(cwd, {
        id: goldenCaseId(toolName, editText, specText),
        at: nowIso(),
        tool: toolName,
        edit: editText,
        spec: specText,
        defers,
        resolved,
        expected: { verdict: verdict.verdict, missing: verdict.missing, reason: verdict.reason },
      });
    } catch {
      /* 캡처 실패는 무시(fail-silent) */
    }
  }

  if (verdict.verdict === "pass") {
    // fail-open(판정 실패) 먼저 분기 — 빈-spec 정상 pass가 fail-open으로 오분류되지 않게.
    if (verdict.failOpen) {
      // 판정 실패로 안전 통과. 캐시하지 않아(작업단위 무력화 방지) 다음 편집에서 재판정.
      // 계측 + systemMessage로 사용자에게 "게이트가 검사 못 했음"을 알린다(조용한 무력화 방지).
      logFailOpen(cwd, toolName, verdict.reason);
      logEvent(cwd, {
        at: nowIso(),
        session,
        specHash: logHash,
        kind: "gate",
        tool: toolName,
        decision: "failopen",
      });
      emit({
        systemMessage: `🐢 거북이 게이트 — 판정 실패로 안전 통과(fail-open). 이 편집은 게이트 검사를 받지 못했습니다: ${verdict.reason}`,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: verdict.reason,
        },
      });
      process.exit(0);
    }
    // 정상 pass. 단 빈 명세 pass는 절대 캐시하지 않는다(상수 hash 영구 우회 방지).
    if (shouldCacheVerdict(verdict, specEmpty)) markGated(cwd, specHash, verdict.reason);
    // scope 큐잉(축A/축B) — 판정된 pass 편집을 Stop서 파급반경·사다리 판정하도록 예약(API 없음).
    maybeEnqueueScope(cwd, toolName, input.tool_input ?? {}, editText, logHash);
    logEvent(cwd, {
      at: nowIso(),
      session,
      specHash: logHash,
      kind: "gate",
      tool: toolName,
      decision: "pass",
      deferCount: defers.length,
    });
    // 업데이트 안내(있으면)만 비차단 노출 — systemMessage 단독은 permissionDecision 없으니
    // 도구를 자동승인하지 않고(통과 동작 보존) 메시지만 표시한다.
    const passNotice = maybeUpdateNotice(cwd, session, ctx);
    if (passNotice) emit({ systemMessage: passNotice });
    process.exit(0); // 정상 통과 (자동승인 X)
  }

  // block: 사람 pause (ask 기본) — 사유가 사용자에게 표시됨
  // 시나리오 미지정(명세 빈약)과 침묵 누락을 다르게 안내한다.
  const reason = buildBlockReason(verdict, specText.trim() === "", source);

  // 침묵-누락 케이스(missing[])를 펜딩-검토에 기록 → 'gbc gate review'가 번호 체크리스트로 회수.
  // judge의 missing[]가 buildBlockReason prose로만 평탄화돼 사라지던 seam 보존(A1). missing 없으면
  // (시나리오 미지정 등) 기록 안 함 = 검토할 케이스 없음. 쓰기 실패는 게이트를 깨지 않는다(fail-silent).
  if (verdict.missing.length > 0) {
    try {
      writePendingReview(cwd, {
        missing: verdict.missing,
        reason: verdict.reason,
        source,
        at: nowIso(),
      });
    } catch {
      /* 펜딩 기록 실패는 무시 — 안내(reason)는 이미 미룸/직접처리 경로를 담고 있다 */
    }
  }

  logEvent(cwd, {
    at: nowIso(),
    session,
    specHash: logHash,
    kind: "gate",
    tool: toolName,
    decision: "block",
    missing: verdict.missing,
    deferCount: defers.length,
  });

  const mode = process.env.GBC_BLOCK_MODE === "deny" ? "deny" : "ask";
  const blockOut: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: mode,
      permissionDecisionReason: reason,
      additionalContext: reason,
    },
  };
  // 업데이트 안내(있으면)를 같은 출력에 top-level systemMessage로 덧붙인다(차단 동작 불변).
  const blockNotice = maybeUpdateNotice(cwd, session, ctx);
  if (blockNotice) blockOut.systemMessage = blockNotice;
  emit(blockOut);
  process.exit(0);
}

/** scope 이벤트의 coarse axis 태그 도출 — rung 걸림이 우선, 아니면 파급반경(scope). */
function scopeAxisTag(v: ScopeVerdict): "scope" | "rung1" | "rung2" | "rung3" {
  if (v.rung === "rung1" || v.rung === "rung2" || v.rung === "rung3") return v.rung;
  return "scope";
}

/**
 * scope 판정 결과를 events.jsonl에 계측 태깅한다(편집별 1 이벤트).
 * 프라이버시 불변식: 열거형 태그만(axis/axisA/rung/context_mode/transport/degraded), 코드 본문·사유
 * 문자열은 절대 넣지 않는다(axisAReason/rungReason 미포함). 계측 실패는 무시(logEvent 내부 fail-silent).
 */
export function logScopeVerdicts(
  cwd: string,
  session: string,
  verdicts: ScopeVerdict[],
  opts: { contextMode: "none" | "grep"; transport: "api" | "cli"; specPresent: boolean },
): void {
  for (const v of verdicts) {
    logEvent(cwd, {
      at: nowIso(),
      session,
      // 큐잉 시점 작업단위 키(있으면) — session×specHash 조인 성립(0.5.4). 미보강은 기존 규약("").
      specHash: v.specHash ?? "",
      kind: "scope",
      axis: scopeAxisTag(v),
      axisA: v.axisA,
      rung: v.rung,
      spec_present: opts.specPresent,
      context_mode: opts.contextMode,
      transport: opts.transport,
      degraded: v.degraded,
    });
  }
}

/**
 * scope 판정 결과(축A broken·rung 걸림)를 사후 표면화용 문자열로 포맷한다. 없으면 "".
 * 차단이 아니라 권고 — "이 편집과 같은 원인이 다른 곳에도 있는지"를 gbc가 이미 판정한 결과다
 * (사용자에게 탐색을 떠넘기지 않는다). degraded(탐색 불가로 미평가)는 표면화 시에만 한 줄 정직 고지.
 */
export function formatScopeFindings(verdicts: ScopeVerdict[], anyDegraded: boolean): string {
  const lines: string[] = [];
  for (const v of verdicts) {
    if (v.axisA === "broken") {
      lines.push(`  · [파급반경] ${v.file}: ${v.axisAReason}`);
    }
    if (v.rung === "rung1" || v.rung === "rung2" || v.rung === "rung3") {
      const label = v.rung === "rung1" ? "과다구현" : v.rung === "rung2" ? "기존코드 재사용" : "표준라이브러리";
      lines.push(`  · [${label}] ${v.file}: ${v.rungReason}`);
    }
  }
  if (lines.length === 0) return "";
  const degradedNote = anyDegraded
    ? "\n(일부 편집은 탐색 컨텍스트 부족으로 파급반경 판정을 생략했습니다.)"
    : "";
  return `🐢 거북이 scope 점검 — 방금 구현의 파급반경·최소구현을 검토했습니다:\n${lines.join("\n")}${degradedNote}`;
}

/**
 * scope 큐를 처리한다(Stop 시점): 실제 grep으로 코드베이스 컨텍스트 수집 → 배치 판정 → 큐 비움 →
 * 표면화 문자열 반환(actionable 없으면 ""). 판정 결과는 metrics로 계측(SubTask 6). 전체 fail-silent.
 * judgeScope만 SDK를 lazy import(hot path 아님 — Stop은 CC가 600s까지 대기).
 */
async function processScopeQueue(cwd: string, session: string): Promise<string> {
  const queue = readScopeQueue(cwd);
  if (queue.length === 0) return "";
  try {
    const { judgeScope, selectedTransport } = await import("./judge.js");
    // CLI 폴백(키 없음)은 호출당 18~30s(스파이크 실측) — SCOPE_TIMEOUT_MS(10s) 안에 못 끝나
    // 매 턴 10s 대기 후 fail-open만 반복된다. 지연 렌즈 권고대로 CLI 트랜스포트는 scope 판정을
    // *시도조차 안 하고* skip한다(조건부 degradation). 정직 계측: degraded 이벤트는 남긴다.
    const transport = selectedTransport();
    if (transport === "cli") {
      clearScopeQueue(cwd);
      const { text: specText } = loadPlanSpec(cwd);
      logScopeVerdicts(
        cwd,
        session,
        queue.map((q) => ({
          file: q.file,
          specHash: q.specHash,
          axisA: "unknown" as const,
          axisAReason: "CLI 트랜스포트 — scope 판정 생략(지연 예산 초과)",
          rung: "unknown" as const,
          rungReason: "",
          degraded: true,
        })),
        { contextMode: "none", transport: "cli", specPresent: specText.trim() !== "" },
      );
      return "";
    }
    const { context, filesWithContext } = await collectGrepContext(cwd, queue);
    // 계획 명세를 판정 입력에 포함 — rung1(YAGNI)은 "요청이 무엇이었나" 없이 판정 불가
    // (스파이크의 rung1 정확도는 명세 존재 조건에서 검증됨 — 판정 조건 정렬).
    const { text: specText } = loadPlanSpec(cwd);
    const rawVerdicts = await judgeScope(queue, context, filesWithContext, { planSpec: specText });
    // 큐잉 시점 specHash 보강 — judgeScope는 계측 무지 유지, 조인키는 이 seam에서만(0.5.4).
    const verdicts = enrichVerdictsWithSpecHash(rawVerdicts, queue);
    clearScopeQueue(cwd);
    logScopeVerdicts(cwd, session, verdicts, {
      contextMode: context ? "grep" : "none",
      transport: selectedTransport(),
      specPresent: specText.trim() !== "",
    });
    return formatScopeFindings(verdicts, verdicts.some((v) => v.degraded));
  } catch (e) {
    // 판정 파이프라인 실패 → 큐를 비워 다음 턴 누적 폭주를 막고 통과하되, **계측은 남긴다**
    // (fail-open 고지 철학 — 조용한 무력화 방지. 게이트 failopen.log와 동일 패턴, "scope" 태그).
    logFailOpen(cwd, "scope", String(e).slice(0, 160));
    try {
      clearScopeQueue(cwd);
    } catch {
      /* 무시 */
    }
    return "";
  }
}

/** Stop: scope 판정(축A/축B) + 미해결 defer 리마인드. stop_hook_active 가드로 턴당 1회. */
export function runStop(): Promise<void> {
  return runHookSafely("stop", stopBody);
}

async function stopBody(onCwd?: (cwd: string) => void): Promise<void> {
  const input = parseHookInput<StopInput>(await readStdin());
  if (input === null) process.exit(0); // 입력 파싱 실패 → 안전하게 통과(fail-open)

  // 이미 한 번 리마인드해 계속 진행 중이면 루프 방지 위해 통과(scope·defer 둘 다 1회만)
  if (input.stop_hook_active === true) process.exit(0);

  const cwd = input.cwd || process.cwd();
  onCwd?.(cwd);
  const session = (input as { session_id?: string }).session_id ?? "";

  // ① scope 판정(축A/축B) — defer와 독립. 큐가 있으면 grep+판정해 사후 표면화. GBC_NO_SCOPE로 opt-out.
  //    무거운 작업이지만 Stop은 hot path가 아니다(CC가 완료까지 대기, 기본 타임아웃 600s).
  let scopeMsg = "";
  if (process.env.GBC_NO_SCOPE !== "1") {
    scopeMsg = await processScopeQueue(cwd, session);
  }

  // ② defer 리마인드(기존) — 음소거 시 스킵. scope와 독립이라 각각 조건 판단.
  let deferMsg = "";
  if (!isStopHintMuted(cwd)) {
    const all = loadDefers(cwd);
    if (all.filter((d) => !isClosedStatus(d.status)).length > 0) deferMsg = buildStopReminder(all);
  }

  // ③ 합쳐서 1회 emit(decision:block=사후 표면화 채널). 둘 다 없으면 조용히 정상 stop.
  const combined = [scopeMsg, deferMsg].filter(Boolean).join("\n\n");
  if (combined) emit({ decision: "block", reason: combined });
  process.exit(0);
}

interface SessionStartInput {
  cwd?: string;
  source?: string;
}

/**
 * defer 전환 행동 규약 — SessionStart/Stop 알림 문자열에 임베드한다.
 * 규약 발화 자리가 hint 문자열인 이유: SKILL.md는 skill 실행 시점에만 읽혀 자유 편집·대화 중엔
 * dead doc이 된다. 매 세션 컨텍스트에 신뢰성 있게 규약을 주입하는 유일한 결정론 채널이 이 문자열이다.
 * (hook엔 추론을 넣지 않는다 — 텍스트만. 자연어/대상 감지·전환 실행은 에이전트 측 책임.)
 */
const DEFER_PROTOCOL =
  "규약 — 항목 착수 시 'gbc defer start <ref>'로 진행중 표시, 사용자가 완료를 명시하면 'gbc defer resolve <ref>'로 종결(신호가 모호하면 resolve하지 말고 확인). 오등록·기각 등 완료가 아닌 정리는 'gbc defer withdraw <ref>'(철회 — resolve와 달리 완료로 기록되지 않음). 되돌리기는 'gbc defer reopen <ref>'. ref=번호|텍스트|all. 모든 자동 전환은 사용자에게 표면화. 작업단위(현재 명세) 전체가 끝나면 'gbc done'으로 명시 종료 — 명세를 아카이브·비우고 게이트를 리셋한다(이걸 안 하면 옛 케이스가 다음 작업단위에 형제로 부활).";

/**
 * 전체 defer 리스트에서 미해결(open+in_progress)만 골라 상태 마커와 함께 한 줄씩 포맷한다.
 * ★ 번호는 전체-리스트 위치(인덱스+1)로 매긴다 — `gbc defer list`·`gbc defer <N>` 인덱스 ref와 동일.
 * 부분집합 번호를 쓰면 resolved가 앞에 있을 때 표시 번호 ≠ 실제 인덱스가 되어 엉뚱한 항목을 친다.
 */
function formatDeferList(all: DeferEntry[]): string {
  return all
    .map((d, i) => ({ d, n: i + 1 }))
    .filter((x) => !isClosedStatus(x.d.status))
    .map((x) => `${x.n}. ${x.d.status === "in_progress" ? "▶[진행중]" : "[미착수]"} ${x.d.item}`)
    .join("\n");
}

/** 미해결 건수를 진행중/미착수로 분해한 머리말 조각 */
function statusBreakdown(unresolved: DeferEntry[]): string {
  const inProgress = unresolved.filter((d) => d.status === "in_progress").length;
  return `진행중 ${inProgress} · 미착수 ${unresolved.length - inProgress}`;
}

/**
 * 세션 진입(startup|resume) 시 미해결 defer 잔여를 표면화하는 알림 문자열. 없으면 "".
 * 입력은 전체 defer 리스트(loadDefers) — 표시 번호를 전체-인덱스로 맞추기 위함(인덱스 ref 정합).
 * gbc 자기 소유 데이터(.gbc/defers.json)만 사용 — scratch/메모리 미접근(다른 하네스와 혼재·환각 방지).
 * in_progress를 open과 구분 표면화("진행중 N · 미착수 M") — 착수했지만 미종결 항목이 잊히지 않게.
 */
export function buildSessionStartHint(all: DeferEntry[]): string {
  const unresolved = all.filter((d) => !isClosedStatus(d.status));
  if (unresolved.length === 0) return "";
  return (
    `🐢 거북이 게이트 — 미해결 defer ${unresolved.length}건 (${statusBreakdown(unresolved)}, 이전 작업 잔여):\n` +
    `${formatDeferList(all)}\n` +
    `필요하면 사용자에게 이어서 처리할지 확인하세요. ${DEFER_PROTOCOL}`
  );
}

/**
 * 등록된 타 repo들의 미해결 defer 요약 한 줄(0.2.9 크로스-repo 가시성). 없으면 "".
 * - 현재 cwd 제외(이미 buildSessionStartHint가 상세 표시), 미해결 0건 repo 제외.
 * - 경로 부재/비-디렉터리/읽기실패는 repo별 조용히 skip(fail-silent). hook이 cwd 밖을 읽는
 *   유일한 지점이라 방어적으로 가드한다(사용자가 명시 등록한 경로만 대상이라 위협은 낮음).
 * - ★ 카운트만. 번호 매긴 상세 리스트는 현재 repo만(formatDeferList) — 번호는 'gbc defer <N>'
 *   인덱스 ref와 cwd 기준으로 묶여, 타 repo에 번호를 주면 어느 repo의 N인지 ref가 깨진다.
 */
export function buildCrossRepoHint(repos: string[], cwd: string): string {
  const here = resolve(cwd);
  const segs: string[] = [];
  for (const repo of repos) {
    const abs = resolve(repo);
    if (abs === here) continue;
    let unresolved: DeferEntry[];
    try {
      // lstatSync(statSync 아님)로 심볼릭 링크를 거부한다 — 등록된 symlink가 가리키는 cwd 밖
      // 임의 경로(/etc 등)의 .gbc/defers.json을 읽으려 시도하는 간접 확장을 막는다(보안검토 S3).
      // 실디렉터리만 isDirectory()=true; symlink면 false라 skip된다.
      if (!existsSync(abs) || !lstatSync(abs).isDirectory()) continue;
      unresolved = loadDefers(abs).filter((d) => !isClosedStatus(d.status));
    } catch {
      continue;
    }
    if (unresolved.length === 0) continue;
    const ip = unresolved.filter((d) => d.status === "in_progress").length;
    const op = unresolved.length - ip;
    const counts = [ip ? `진행중${ip}` : "", op ? `미착수${op}` : ""].filter(Boolean).join("·");
    const name = abs.split(/[\\/]/).filter(Boolean).pop() ?? abs;
    segs.push(`${name} ${counts}`);
  }
  return segs.length ? `🌐 타 repo 미해결: ${segs.join(" · ")}` : "";
}

/**
 * Stop hook 리마인드 문자열. 없으면 "". 입력은 전체 defer 리스트(번호=전체-인덱스, 인덱스 ref 정합).
 * SessionStart와 동일하게 in_progress를 차등 표면화한다 — "착수했지만 미종결" 항목이 레이더에서
 * 사라지지 않게(resolve가 리마인드에서 항목을 떨구는 harm 완화).
 */
export function buildStopReminder(all: DeferEntry[]): string {
  const unresolved = all.filter((d) => !isClosedStatus(d.status));
  if (unresolved.length === 0) return "";
  return (
    `🐢 미해결 defer ${unresolved.length}건이 남아 있습니다 (${statusBreakdown(unresolved)}):\n` +
    `${formatDeferList(all)}\n` +
    // 문구는 실동작과 일치해야 한다(결함C): 세션 1회 dedup은 존재하지 않고, stop_hook_active
    // 가드는 턴 내 루프 방지뿐 — 미해결이 남아 있는 한 매 턴 발화가 의도 설계(opt-out=/gbc-mute).
    `${DEFER_PROTOCOL} 다음 세션으로 이월할 거면 의식적으로 확인하세요. (이 리마인드는 미해결 defer가 남아 있는 동안 매 턴 표시됩니다 — 끄기: /gbc-mute)`
  );
}

/**
 * SessionStart 출력 직렬화 — 청중분리(2026-06-29, project_update_notice_visibility_gap 3층 갭).
 * contextParts(defer/크로스repo 힌트)는 hookSpecificOutput.additionalContext로 Claude 컨텍스트에,
 * userNotice(업데이트 안내)는 top-level systemMessage로 사용자에게 직접 배너 표시한다
 * (실측 확정: SessionStart systemMessage는 `⎿ SessionStart:startup says:` 배너로 렌더됨).
 * 둘 다 비면 ""(무출력 — 현행 동작 보존). permissionDecision 없음 = 비차단.
 */
export function buildSessionStartPayload(contextParts: string[], userNotice: string): string {
  const out: {
    hookSpecificOutput?: { hookEventName: "SessionStart"; additionalContext: string };
    systemMessage?: string;
  } = {};
  const ctx = contextParts.filter((p) => p && p.trim()).join("\n");
  if (ctx) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: ctx };
  if (userNotice && userNotice.trim()) out.systemMessage = userNotice;
  return Object.keys(out).length ? JSON.stringify(out) : "";
}

/**
 * SessionStart: 세션 진입 시 출력을 JSON으로 청중분리(Option X, project_update_notice_visibility_gap).
 * defer/크로스repo 힌트 → additionalContext(Claude 컨텍스트), 업데이트 안내 → systemMessage(사용자
 * 직접 배너). 둘 다 없으면 무출력. GBC_NO_SESSION_HINT·GBC_NO_UPDATE_NOTICE로 각각 opt-out.
 * 결정론적(LLM·코드비교 없음)·비차단(exit 0).
 */
export function runSessionStart(ctx?: HookContext): Promise<void> {
  return runHookSafely("session-start", (onCwd) => sessionStartBody(ctx, onCwd));
}

async function sessionStartBody(ctx?: HookContext, onCwd?: (cwd: string) => void): Promise<void> {
  const input = parseHookInput<SessionStartInput>(await readStdin());
  if (input === null) process.exit(0); // 입력 파싱 실패 → 안전하게 통과(fail-open)
  const cwd = input.cwd || process.cwd();
  onCwd?.(cwd);
  // 청중분리(Option X): contextParts는 additionalContext(Claude 컨텍스트), userNotice는
  // systemMessage(사용자 직접 배너). buildSessionStartPayload가 JSON 직렬화.
  const contextParts: string[] = [];
  let userNotice = "";
  // 미해결 defer 알림(GBC_NO_SESSION_HINT로 opt-out — 기존 동작 보존).
  if (process.env.GBC_NO_SESSION_HINT !== "1") {
    const hint = buildSessionStartHint(loadDefers(cwd));
    if (hint) {
      contextParts.push(hint);
      // Stop 리마인드 음소거 중이면 진입 시 1회 환기("꺼둔 걸 잊지 않게"). hint가 있을 때만
      // = 미해결 defer가 있을 때만(잔여 0이면 음소거 무관·노이즈). buildSessionStartHint는
      // 순수 유지하고 오케스트레이션에서만 한 줄 첨부(시그니처 미오염).
      if (isStopHintMuted(cwd)) {
        contextParts.push("🔕 Stop 리마인드 음소거 중 — 매 대화 종료 알림은 꺼져 있습니다 (해제: /gbc-mute).");
      }
    }
  }
  // 크로스-repo defer 가시성(0.2.9) — 등록된 타 repo 미해결 요약. SessionStart만(Stop엔 미첨부).
  // opt-out 둘: GBC_NO_SESSION_HINT(세션힌트 전체) 또는 GBC_NO_CROSS_REPO(이 줄만).
  if (process.env.GBC_NO_SESSION_HINT !== "1" && process.env.GBC_NO_CROSS_REPO !== "1") {
    try {
      const xr = buildCrossRepoHint(loadRepos(), cwd);
      if (xr) contextParts.push(xr);
    } catch {
      /* 레지스트리 읽기 실패는 무시(fail-silent) */
    }
  }
  // ①신버전 안내 — 캐시가 stale이면 '표시 전에' 먼저 갱신(1.5s 상한, fail-silent)해 이번 세션에
  // 즉시 반영한다(표시-후-갱신의 '다음 세션 지연' 제거). SessionStart는 게이트를 막지 않으므로
  // 짧은 네트워크가 안전(advisor 승인). 갱신은 24h TTL당 1회만 발생.
  try {
    if (ctx?.cliPath && process.env.GBC_NO_UPDATE_NOTICE !== "1" && isCacheStale(readVersionCache())) {
      await refreshVersionCache();
    }
  } catch {
    /* 갱신 실패는 무시(fail-silent) */
  }
  // 업데이트 안내(staleness + version) — SessionStart 보유 코호트(0.2.3+)용. 세션 식별자가 없어
  // 항상 표시되므로 dedup 대신 GBC_NO_UPDATE_NOTICE opt-out에 맡긴다(buildUpdateNotice 내부).
  // 위에서 갱신된 캐시를 읽으므로 신버전이 뜨는 그 세션에 즉시 표시된다.
  try {
    if (ctx?.cliPath) {
      const notice = buildUpdateNotice(readProjectSettings(cwd), ctx.cliPath, ctx.version ?? "");
      if (notice) userNotice = notice;
    }
  } catch {
    /* 안내 실패는 무시(fail-silent) */
  }
  // 청중분리 직렬화: 힌트→additionalContext(Claude), 안내→systemMessage(사용자 직접 배너).
  // 둘 다 비면 무출력(현행 동작 보존). 비차단(exit 0) 유지.
  const payload = buildSessionStartPayload(contextParts, userNotice);
  if (payload) process.stdout.write(payload);
  process.exit(0);
}
