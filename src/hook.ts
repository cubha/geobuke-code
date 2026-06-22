// PreToolUse / Stop hook 핸들러.
// 핫패스 보호: 이 파일은 SDK를 import하지 않는다. judge.ts가 API 호출 시에만 lazy import.
// "이미 게이트됨 → exit 0"은 상태파일만 읽고 즉시 종료(judge 미호출).
import { isGatedTool, normalizeEdit } from "./normalize.js";
import { loadPlanSpec, computeSpecHash } from "./spec.js";
import { isGated, markGated } from "./state.js";
import { activeDeferItems, unresolvedDefers, loadDefers } from "./defer.js";
import { readProjectSettings, buildUpdateNotice, wasNotified, markNotified } from "./notice.js";
import { isCacheStale, readVersionCache, refreshVersionCache } from "./version.js";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { gbcDir } from "./store.js";
import { logEvent } from "./metrics.js";
import type { EditToolInput, Verdict, DeferEntry } from "./types.js";

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
  return (
    `🐢 거북이 게이트 — ${verdict.reason}${missingLine}\n` +
    `→ 지금 이 변경에서 다루거나, 의도적으로 미룰 거면 'gbc defer add "<케이스>"'로 명시 등록 후 진행하세요.` +
    ` (명세 소스: ${source})`
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

/** PreToolUse: 코드 변경 직전 게이트 */
export async function runPreToolUse(ctx?: HookContext): Promise<void> {
  let input: PreToolUseInput = {};
  try {
    const raw = await readStdin();
    input = raw ? (JSON.parse(raw) as PreToolUseInput) : {};
  } catch {
    // 입력 파싱 실패 → 안전하게 통과(fail-open)
    process.exit(0);
  }

  const toolName = input.tool_name ?? "";
  const cwd = input.cwd || process.cwd();
  const session = input.session_id ?? "";

  // 코드 변경 도구가 아니면 즉시 통과
  if (!isGatedTool(toolName)) process.exit(0);

  // 명시적 우회 (계측됨)
  if (process.env.GBC_NO_GATE === "1") {
    logBypass(cwd, toolName);
    logEvent(cwd, { at: nowIso(), session, specHash: "", kind: "bypass", tool: toolName });
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
    process.exit(0);
  }

  // judge는 여기서만 동적 import (SDK lazy)
  const { judge } = await import("./judge.js");
  const editText = normalizeEdit(toolName, input.tool_input ?? {});
  const defers = activeDeferItems(cwd);
  const verdict = await judge(specText, editText, defers);

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

/** Stop: 미해결 defer 리마인드 (stop_hook_active 가드로 1회만) */
export async function runStop(): Promise<void> {
  let input: StopInput = {};
  try {
    const raw = await readStdin();
    input = raw ? (JSON.parse(raw) as StopInput) : {};
  } catch {
    process.exit(0);
  }

  // 이미 한 번 리마인드해 계속 진행 중이면 루프 방지 위해 통과
  if (input.stop_hook_active === true) process.exit(0);

  const cwd = input.cwd || process.cwd();
  // defers.json 없으면(파일 부재) 조용히 통과
  if (loadDefers(cwd).length === 0) process.exit(0);

  const un = unresolvedDefers(cwd);
  if (un.length === 0) process.exit(0);

  const items = un.map((d, i) => `${i + 1}. ${d.item}`).join("\n");
  emit({
    decision: "block",
    reason:
      `🐢 미해결 defer ${un.length}건이 남아 있습니다:\n${items}\n` +
      `해결했으면 'gbc defer resolve <번호>', 다음 세션으로 이월할 거면 의식적으로 확인하세요. ` +
      `(이 리마인드는 1회만 표시됩니다.)`,
  });
  process.exit(0);
}

interface SessionStartInput {
  cwd?: string;
  source?: string;
}

/**
 * 세션 진입(startup|resume) 시 미해결 defer 잔여를 표면화하는 알림 문자열. 없으면 "".
 * gbc 자기 소유 데이터(.gbc/defers.json)만 사용 — scratch/메모리 미접근(다른 하네스와 혼재·환각 방지).
 */
export function buildSessionStartHint(unresolved: DeferEntry[]): string {
  if (unresolved.length === 0) return "";
  const items = unresolved.map((d, i) => `${i + 1}. ${d.item}`).join("\n");
  return (
    `🐢 거북이 게이트 — 미해결 defer ${unresolved.length}건 (이전 작업 잔여):\n${items}\n` +
    `필요하면 사용자에게 이어서 처리할지 확인하세요. 해결은 'gbc defer resolve <번호>'.`
  );
}

/**
 * SessionStart: 세션 진입 시 미해결 defer를 stdout(plain text)으로 표면화 → Claude 컨텍스트 주입.
 * 잔여 없으면 무출력. GBC_NO_SESSION_HINT=1로 opt-out. 결정론적(LLM·코드비교 없음).
 */
export async function runSessionStart(ctx?: HookContext): Promise<void> {
  let input: SessionStartInput = {};
  try {
    const raw = await readStdin();
    input = raw ? (JSON.parse(raw) as SessionStartInput) : {};
  } catch {
    process.exit(0);
  }
  const cwd = input.cwd || process.cwd();
  const parts: string[] = [];
  // 미해결 defer 알림(GBC_NO_SESSION_HINT로 opt-out — 기존 동작 보존).
  if (process.env.GBC_NO_SESSION_HINT !== "1") {
    const hint = buildSessionStartHint(unresolvedDefers(cwd));
    if (hint) parts.push(hint);
  }
  // 업데이트 안내(staleness + version) — SessionStart 보유 코호트(0.2.3+)용. 세션 식별자가 없어
  // 항상 표시되므로 dedup 대신 GBC_NO_UPDATE_NOTICE opt-out에 맡긴다(buildUpdateNotice 내부).
  try {
    if (ctx?.cliPath) {
      const notice = buildUpdateNotice(readProjectSettings(cwd), ctx.cliPath, ctx.version ?? "");
      if (notice) parts.push(notice);
    }
  } catch {
    /* 안내 실패는 무시(fail-silent) */
  }
  if (parts.length > 0) process.stdout.write(parts.join("\n"));
  // 버전 캐시 갱신은 '표시 후'에만(이번 출력은 캐시값 기준, 갱신은 다음 세션용). SessionStart는
  // 게이트를 막지 않으므로 짧은 타임아웃 네트워크가 안전(advisor 승인). 실패는 조용히 무시.
  try {
    if (ctx?.cliPath && process.env.GBC_NO_UPDATE_NOTICE !== "1" && isCacheStale(readVersionCache())) {
      await refreshVersionCache();
    }
  } catch {
    /* 갱신 실패는 무시(fail-silent) */
  }
  process.exit(0);
}
