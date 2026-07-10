// SDK PreToolUse 콜백 어댑터 (0.7.0 A1 ST4) — evaluateGate GateDecision을 agent-sdk의 in-process
// HookJSONOutput으로 번역한다(applyGateDecision[stdin]의 SDK 미러). 판정 코어(evaluateGate)와 효과
// 커밋(commitGateEffects)은 gate-core/hook과 공유 — 여기선 *출력 매핑*과 *fail-open 정형채널*만 A-mode용.
// ⚠️ 장수 프로세스라 exit(process.exit)의 의미가 없다 — stdin 경로의 exit-silent/exit-gate/emit-direct를
//    전부 return값(HookJSONOutput)으로 채널화한다. fail-open도 exit가 아니라 allow+고지 return.
// 타입은 import type(erased) — agent-sdk 런타임 로드 없음(B경로 격리 규율 동일).
import type {
  HookCallback,
  HookInput,
  PreToolUseHookInput,
  SyncHookJSONOutput,
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { GateDecision, GateDeps } from "./gate-core.js";
import type { EditToolInput } from "./types.js";
import { createInterface } from "node:readline";
import { evaluateGate, defaultGateDeps } from "./gate-core.js";
import { commitGateEffects } from "./hook.js";

/**
 * GateDecision.output을 SDK PreToolUse 출력(SyncHookJSONOutput)으로 매핑한다(순수).
 * - exit-silent(passthrough/bypass) → {} : 의견 없음(도구 진행). stdin의 무출력 exit와 등가.
 * - exit-gate + permission 없음(doc-skip/cached/pass) → {} : allow(통과). 버전 안내는 stdin 전용이라 생략.
 * - exit-gate + permission(block) → hookSpecificOutput{permissionDecision: ask|deny, reason, additionalContext}.
 * - emit-direct(fail-open) → systemMessage(고지) + hookSpecificOutput{permissionDecision: allow, reason}.
 */
export function gateDecisionToHookOutput(decision: GateDecision): SyncHookJSONOutput {
  const { mode, permission, userMessage } = decision.output;
  if (mode === "emit-direct") {
    // fail-open: allow + 고지(안내 미첨부). stdin의 emit-direct 미러.
    return {
      systemMessage: userMessage,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: permission?.decision ?? "allow",
        permissionDecisionReason: permission?.reason ?? "",
      },
    };
  }
  if (mode === "exit-gate" && permission) {
    // block: ask|deny + 사유(additionalContext까지 = stdin 차단 출력 미러).
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: permission.decision,
        permissionDecisionReason: permission.reason,
        additionalContext: permission.reason,
      },
    };
  }
  // exit-silent(passthrough/bypass) + exit-gate permission 없음(doc-skip/cached/pass) → 의견 없음(통과).
  // 버전 업데이트 안내는 stdin 전용이라 SDK 경로엔 첨부하지 않는다.
  return {};
}

/**
 * A-mode PreToolUse HookCallback 팩토리. 매 도구 호출마다 evaluateGate로 판정 → 효과 커밋 →
 * SDK 출력으로 매핑. deps 미지정 시 프로덕션 배선(defaultGateDeps). infra throw는 정형 fail-open
 * (allow+고지)으로 흡수 — 장수 프로세스라 stdin의 runHookSafely(exit 0)를 return으로 치환한 것.
 * onDecision(0.9.0 A3a TUI seam, engine.ts의 onMessage와 대칭): 판정 성공마다 GateDecision을 관측
 * 콜백에 넘긴다(부작용 허용, 반환값 무시·throw해도 훅 응답엔 영향 없음) — TUI가 GATE_RESULT
 * TuiEvent(specCount·deferCount)를 조립하는 지점. B-모드 핫패스(stdin hook.ts)는 이 콜백을 쓰지 않음.
 */
export function makeSdkPreToolUseHook(
  cwd: string,
  deps?: GateDeps,
  onDecision?: (decision: GateDecision) => void,
): HookCallback {
  return async (input: HookInput): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput & { session_id?: string };
    try {
      const decision = await evaluateGate(
        {
          toolName: pre.tool_name,
          toolInput: (pre.tool_input ?? {}) as EditToolInput,
          cwd,
          session: pre.session_id ?? "",
        },
        deps ?? defaultGateDeps(),
      );
      commitGateEffects(cwd, decision);
      if (onDecision) {
        try {
          onDecision(decision);
        } catch {
          // TUI 관측 콜백의 오류가 게이트 판정·도구 실행을 절대 끊지 않는다(engine.ts onMessage와 동일 규율).
        }
      }
      return gateDecisionToHookOutput(decision);
    } catch (e) {
      // 이 catch는 evaluateGate 자체가 throw한 경우(디스크 실패 등 infra 오류) — 유효한 GateDecision이
      // 없어 onDecision을 부를 대상 자체가 없다(합성 decision을 지어내지 않음, 결정 확정: 2026-07-10
      // ST5 자체검토). TUI 게이트 줄은 이 희귀 케이스에서 갱신되지 않지만 fail-open이라 도구는 정상
      // 진행되고, 아래 systemMessage는 SDK가 시스템 메시지로 노출한다(스크롤백 가시성은 별개 채널).
      return {
        systemMessage: `🐢 거북이 게이트 — 내부 오류로 검사 없이 안전 통과(fail-open): ${String(e).slice(0, 120)}`,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: String(e).slice(0, 120),
        },
      };
    }
  };
}

// ===== ST5 canUseTool 사람-pause primitive =====

/**
 * pause 응답(사람 입력)을 PermissionResult로 해석한다(순수·결정론 — TDD 대상).
 * y/yes(대소문자·공백 무관) → allow, 그 외(빈 입력·n·EOF) → deny(기본 거부 = 고무도장 방지).
 * ⚠️ allow 분기는 반드시 updatedInput(도구 원본 인자)을 담아야 한다 — SDK PermissionResult 런타임
 *    zod 스키마가 allow에 updatedInput(record)을 요구한다(.d.ts optional과 불일치, ST7 E2E 실측:
 *    누락 시 모든 권한요청이 ZodError로 실패해 도구가 하나도 실행 안 됨). 인자 변경 없이 그대로 통과.
 */
export function interpretPauseAnswer(answer: string, input: Record<string, unknown> = {}): PermissionResult {
  return /^\s*y(es)?\s*$/i.test(answer)
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "사용자가 도구 실행을 거부함 (pause)" };
}

/**
 * canUseTool 사람-pause 팩토리 — 도구 실행 직전 stdin으로 사람에게 허용을 묻는 최소 blocking primitive
 * (고무도장 방지). PreToolUse 게이트(자동 판정)와 직교: 게이트가 통과시켜도 사람이 최종 pause할 수 있다.
 * autoAllow=true면 비대화형(CI·E2E 자동)용으로 즉시 allow. 프롬프트는 stderr로(SDK stdout 스트림 미오염).
 * readline 배선은 대화형이라 TDD 제외 — 결정론 코어는 interpretPauseAnswer가 담당(수동 검증은 ST7 E2E).
 */
export function makeStdinPauseCanUseTool(opts: { autoAllow?: boolean } = {}): CanUseTool {
  return async (toolName, input) => {
    // allow 시 updatedInput 필수(SDK zod 스키마, ST7). autoAllow도 원본 인자를 그대로 담아 통과.
    if (opts.autoAllow) return { behavior: "allow", updatedInput: input };
    const file = typeof (input as { file_path?: unknown })?.file_path === "string"
      ? ` ${(input as { file_path: string }).file_path}`
      : "";
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await new Promise<string>((resolve) =>
        rl.question(`🐢 [pause] ${toolName}${file} 실행을 허용할까요? (y/N): `, resolve),
      );
      return interpretPauseAnswer(answer, input);
    } finally {
      rl.close();
    }
  };
}
