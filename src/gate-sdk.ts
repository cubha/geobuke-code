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
} from "@anthropic-ai/claude-agent-sdk";
import type { GateDecision, GateDeps } from "./gate-core.js";
import type { EditToolInput } from "./types.js";
import { evaluateGate, defaultGateDeps } from "./gate-core.js";
import { commitGateEffects } from "./hook.js";

/**
 * GateDecision.output을 SDK PreToolUse 출력(SyncHookJSONOutput)으로 매핑한다(순수).
 * - exit-silent(passthrough/bypass) → {} : 의견 없음(도구 진행). stdin의 무출력 exit와 등가.
 * - exit-gate + permission 없음(doc-skip/cached/pass) → {} : allow(통과). 버전 안내는 stdin 전용이라 생략.
 * - exit-gate + permission(block) → hookSpecificOutput{permissionDecision: ask|deny, reason, additionalContext}.
 * - emit-direct(fail-open) → systemMessage(고지) + hookSpecificOutput{permissionDecision: allow, reason}.
 */
export function gateDecisionToHookOutput(_decision: GateDecision): SyncHookJSONOutput {
  throw new Error("gateDecisionToHookOutput: not implemented (ST4 RED)");
}

/**
 * A-mode PreToolUse HookCallback 팩토리. 매 도구 호출마다 evaluateGate로 판정 → 효과 커밋 →
 * SDK 출력으로 매핑. deps 미지정 시 프로덕션 배선(defaultGateDeps). infra throw는 정형 fail-open
 * (allow+고지)으로 흡수 — 장수 프로세스라 stdin의 runHookSafely(exit 0)를 return으로 치환한 것.
 */
export function makeSdkPreToolUseHook(cwd: string, deps?: GateDeps): HookCallback {
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
      return gateDecisionToHookOutput(decision);
    } catch (e) {
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
