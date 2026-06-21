// PreToolUse / Stop hook 핸들러.
// 핫패스 보호: 이 파일은 SDK를 import하지 않는다. judge.ts가 API 호출 시에만 lazy import.
// "이미 게이트됨 → exit 0"은 상태파일만 읽고 즉시 종료(judge 미호출).
import { isGatedTool, normalizeEdit } from "./normalize.js";
import { loadPlanSpec, computeSpecHash } from "./spec.js";
import { isGated, markGated } from "./state.js";
import { activeDeferItems, unresolvedDefers, loadDefers } from "./defer.js";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { gbcDir } from "./store.js";
import { logEvent } from "./metrics.js";
import type { EditToolInput, Verdict } from "./types.js";

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
 * fail-open(판정 실패 안전통과)은 제외 — 일시 장애가 작업단위 내내 게이트를 무력화하는 것을 막는다.
 */
export function shouldCacheVerdict(verdict: Verdict): boolean {
  return verdict.verdict === "pass" && !verdict.failOpen;
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

/** PreToolUse: 코드 변경 직전 게이트 */
export async function runPreToolUse(): Promise<void> {
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
  // 계측용 해시: 빈 spec은 ""(센티넬)로 기록 → M1 churn 교차세션 합산 방지.
  // (게이트 캐시용 specHash는 그대로 — markGated/isGated 동작 불변)
  const logHash = specText.trim() === "" ? "" : specHash;

  // 작업단위 1회: 이미 게이트 통과한 단위면 즉시 통과 (judge 미호출, 핫패스)
  // 계측: cached-skip도 기록해야 M3(작업단위당 edit 반복)이 진짜 횟수를 잡는다.
  if (isGated(cwd, specHash)) {
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
    if (shouldCacheVerdict(verdict)) {
      markGated(cwd, specHash, verdict.reason);
      logEvent(cwd, {
        at: nowIso(),
        session,
        specHash: logHash,
        kind: "gate",
        tool: toolName,
        decision: "pass",
        deferCount: defers.length,
      });
      process.exit(0); // 정상 통과 (자동승인 X — 무출력)
    }
    // fail-open: 판정 실패로 안전 통과. 캐시하지 않아(작업단위 무력화 방지) 다음 편집에서 재판정.
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
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: mode,
      permissionDecisionReason: reason,
      additionalContext: reason,
    },
  });
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
