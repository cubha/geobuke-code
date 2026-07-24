// PreToolUse / Stop hook 핸들러.
// 핫패스 보호: 이 파일은 SDK를 import하지 않는다. judge.ts가 API 호출 시에만 lazy import.
// "이미 게이트됨 → exit 0"은 상태파일만 읽고 즉시 종료(judge 미호출).
import { loadPlanSpec } from "./spec.js";
import { markGated } from "./state.js";
import { loadDefers, isClosedStatus, unresolvedDefers } from "./defer.js";
import { isStopHintMuted } from "./config.js";
import { loadRepos } from "./repos.js";
import { writePendingReview } from "./review.js";
import { addGoldenCase } from "./golden.js";
import { enqueueScope, readScopeQueue, clearScopeQueue, collectGrepContext, enrichVerdictsWithSpecHash } from "./scope.js";
import { readProjectSettings, buildUpdateNotice, wasNotified, markNotified } from "./notice.js";
import { refreshVersionCache, shouldRefreshCache, refreshCacheIfStale } from "./version.js";
import { appendFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { gbcDir, resolveProjectRoot, basenameOf } from "./store.js";
import { nowIso } from "./time.js";
import { logEvent } from "./metrics.js";
import {
  isDocFile,
  buildBlockReason,
  shouldCacheVerdict,
  CODE_FILE_RE,
  evaluateGate,
  defaultGateDeps,
} from "./gate-core.js";
import type { GateDecision } from "./gate-core.js";
import type { EditToolInput, Verdict, DeferEntry, ScopeVerdict } from "./types.js";

// 순수 게이트 헬퍼는 gate-core.ts로 이관(0.7.0 A1 ST1) — hook은 재export로 기존 import 계약 보존
// (test/unit.test.mjs가 hook.js에서 buildBlockReason·shouldCacheVerdict·isDocFile를 import).
export { isDocFile, buildBlockReason, shouldCacheVerdict };

interface PreToolUseInput {
  tool_name?: string;
  tool_input?: EditToolInput;
  cwd?: string;
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

function logBypass(cwd: string, toolName: string): void {
  try {
    appendFileSync(join(gbcDir(cwd), "bypass.log"), `${nowIso()} ${toolName}\n`);
  } catch {
    /* 계측 실패는 무시 */
  }
}

/** fail-open(판정 실패 안전통과) 계측 — 게이트가 무력화된 편집을 사후 추적할 수 있게 한다. */
function logFailOpen(cwd: string, toolName: string, reason: string): void {
  try {
    appendFileSync(
      join(gbcDir(cwd), "failopen.log"),
      `${nowIso()} ${toolName} ${reason}\n`,
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

/**
 * 게이트 판정 출구 공통화(0.6.1 R9) — 업데이트 안내(세션 1회 dedup)를 출구에서 1회 결합해 emit 후
 * 종료한다. 종전엔 maybeUpdateNotice가 4분기(doc-skip·cached·pass·block)에 교차 삽입돼 판정 로직과
 * 직교 관심사가 섞여 있었다(A1 evaluateGate 추출 대상 축소를 위한 선행 분리).
 * ⚠️ 안내는 출구 시점에 계산해야 한다(선계산 금지) — pass/block 경로는 judge와 병렬로 refresh된
 * 버전 캐시(0.3.0)를 읽어야 그 편집에서 신버전이 즉시 뜬다. fail-open 출구는 이 함수를 쓰지 않는다
 * (종전에도 안내 미첨부 — 실패 고지 systemMessage와 섞지 않는 기존 동작 보존).
 */
function exitGate(
  cwd: string,
  session: string,
  ctx: HookContext | undefined,
  out?: Record<string, unknown>,
): never {
  const notice = maybeUpdateNotice(cwd, session, ctx);
  const payload: Record<string, unknown> = { ...(out ?? {}) };
  if (notice) payload.systemMessage = notice;
  if (Object.keys(payload).length > 0) emit(payload);
  process.exit(0);
}

// CODE_FILE_RE·DOC_FILE_RE·isDocFile은 gate-core.ts로 이관(0.7.0 A1 ST1). CODE_FILE_RE는 상단에서
// import(maybeEnqueueScope 사용), isDocFile은 상단에서 재export(test 계약 보존).

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

  // 0.9.3 ST1 — 조상 walk-up으로 프로젝트 루트를 찾는다. hook 진입 cwd가 프로젝트 루트 하위
  // 디렉토리면 loadPlanSpec(조상 탐색 없음)이 spec.md를 못 찾아 "명세 소스: (없음)"으로 오판하던
  // 근본원인(fa-support 도그푸딩 리포트, 2026-07-13)을 이 진입점에서 정정한다.
  const cwd = resolveProjectRoot(input.cwd || process.cwd());
  onCwd?.(cwd);
  const session = input.session_id ?? "";

  // 버전캐시 refresh seam(a) — judge와 병렬로만 발화(cached/doc-skip 경로엔 안 실림, 0.2.7 보존).
  // shouldRefreshCache는 thunk 안에서 평가 → evaluateGate가 judge 경로에 도달할 때만 판정(기존 호출
  // 시점·병렬성 1:1). refreshVersionCache는 내부 fail-silent(reject 불가)라 judge 경로를 깨지 않는다.
  const refresh = (): Promise<void> =>
    shouldRefreshCache(Boolean(ctx?.cliPath)) ? refreshVersionCache() : Promise.resolve();

  const decision = await evaluateGate(
    { toolName: input.tool_name ?? "", toolInput: input.tool_input ?? {}, cwd, session },
    defaultGateDeps(refresh),
  );
  applyGateDecision(cwd, session, ctx, decision);
}

/**
 * GateDecision의 effects를 실제 디스크·계측에 커밋한다(stdin·SDK 공통 — ST4 gate-sdk가 재사용). 개별 쓰기
 * 실패는 게이트를 막지 않는다(fail-silent, 기존 hook 동작 보존). logEvent는 내부 fail-silent.
 */
export function commitGateEffects(cwd: string, decision: GateDecision): void {
  const e = decision.effects;
  const tool = decision.event?.tool ?? "";
  if (e.logBypass) logBypass(cwd, tool);
  if (e.logFailOpen) logFailOpen(cwd, tool, e.logFailOpen);
  if (e.markGated) markGated(cwd, e.markGated.specHash, e.markGated.reason);
  if (e.enqueueScope) {
    maybeEnqueueScope(cwd, e.enqueueScope.toolName, e.enqueueScope.input, e.enqueueScope.editText, e.enqueueScope.specHash);
  }
  if (e.goldenCapture) {
    try {
      addGoldenCase(cwd, e.goldenCapture);
    } catch {
      /* 캡처 실패는 무시(fail-silent) */
    }
  }
  if (e.pendingReview) {
    try {
      writePendingReview(cwd, e.pendingReview);
    } catch {
      /* 펜딩 기록 실패는 무시 — 안내(reason)는 이미 미룸/직접처리 경로를 담고 있다 */
    }
  }
  if (decision.event) logEvent(cwd, decision.event);
}

/**
 * GateDecision을 stdin hook 응답으로 번역한다(effects 커밋 후 output.mode에 따라 exit/emit). never.
 * - exit-silent: 무출력 종료(passthrough·bypass).
 * - exit-gate: 버전 안내 첨부 출구(exitGate). block은 permission 동반, doc-skip/cached/pass는 notice-only.
 * - emit-direct: 안내 미첨부 직접 emit(fail-open — 실패 고지와 안내를 섞지 않는 기존 동작 보존).
 */
function applyGateDecision(
  cwd: string,
  session: string,
  ctx: HookContext | undefined,
  decision: GateDecision,
): never {
  commitGateEffects(cwd, decision);
  const { mode, permission, userMessage } = decision.output;
  if (mode === "exit-silent") process.exit(0);
  if (mode === "emit-direct") {
    emit({
      systemMessage: userMessage,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: permission?.decision ?? "allow",
        permissionDecisionReason: permission?.reason ?? "",
      },
    });
    process.exit(0);
  }
  // exit-gate: 업데이트 안내(있으면)는 exitGate가 같은 출력에 top-level systemMessage로 결합한다.
  if (permission) {
    exitGate(cwd, session, ctx, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: permission.decision,
        permissionDecisionReason: permission.reason,
        additionalContext: permission.reason,
      },
    });
  }
  exitGate(cwd, session, ctx);
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

  // 0.9.3 ST1(scope-critic 발견 확대) — PreToolUse만 resolveProjectRoot를 적용하면 같은 세션의
  // scope-queue.json을 PreToolUse(resolve된 cwd)는 프로젝트 루트에 쓰고 Stop(raw cwd)은 하위
  // 디렉토리에서 읽어 producer/consumer가 갈라지는 새 회귀가 난다(수정 전엔 둘 다 raw라 최소
  // 일치했음). loadDefers·loadPlanSpec(processScopeQueue 내부)도 동일 근본원인이라 여기서 함께 정정.
  const cwd = resolveProjectRoot(input.cwd || process.cwd());
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
      // 단일 lstatSync로 부재/symlink를 한 번에 판정(0.6.1 R5) — existsSync+lstatSync 분리는
      // 자기 프로젝트가 W1에서 폐기한 TOCTOU 패턴(cli.ts cmdMetrics·cmdRepos 표준과 통일).
      // lstat은 링크를 안 따라가 symlink면 isDirectory()=false(보안검토 S3), 부재는 throw→catch skip.
      if (!lstatSync(abs).isDirectory()) continue;
      unresolved = unresolvedDefers(abs);
    } catch {
      continue;
    }
    if (unresolved.length === 0) continue;
    const ip = unresolved.filter((d) => d.status === "in_progress").length;
    const op = unresolved.length - ip;
    const counts = [ip ? `진행중${ip}` : "", op ? `미착수${op}` : ""].filter(Boolean).join("·");
    const name = basenameOf(abs); // store.ts 공용(2026-07-24 리팩토링, R1) — 경로 부재면 abs 그대로.
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
  // 0.9.3 ST1 — PreToolUse/Stop과 동일 이유로 SessionStart도 프로젝트 루트로 정정(loadDefers가
  // 하위 디렉토리 cwd에서 defers.json을 못 찾아 "미해결 0건"으로 오판하는 것 방지, 세 진입점의
  // input.cwd 해석 계약을 일관되게 유지).
  const cwd = resolveProjectRoot(input.cwd || process.cwd());
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
  await refreshCacheIfStale(Boolean(ctx?.cliPath));
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
