// 0.9.0 A3a ST4 — 엔진 스트림·승인 프롬프트 브리지(순수부만 — I/O는 이 파일 밖).
//
// 아키텍처 확정 근거(advisor 검토 + cli.ts:201 실측): A-mode의 "block→도출→등록→재시도" 사이클은
// **에이전트 주도**다 — 게이트가 BLOCK하면 에이전트가 스스로 시나리오를 도출해 자기 Bash 도구로
// `gbc spec add "..."`를 호출하고, canUseTool이 그 호출 자체를 pause한다(gbc의 PreToolUse 게이트가
// 아니다 — "PreToolUse hook denies bypass canUseTool"이라 애초에 게이트 자체는 이 경로에 없다).
// 따라서 이 파일은 gbc spec add/defer를 직접 실행하지 않는다 — "무엇을 할지"만 기술하고, 실제
// addSpecCase/addDefer 호출과 engine.ts onMessage 배선은 이 파일을 소비하는 impure 글루(ST5)가 한다.
//
// usagePct(컨텍스트 사용량)는 의도적으로 다루지 않는다: agent-sdk의 컨텍스트 사용량 API가
// `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`로 명시된 실험적 control-request라
// 지금 배선하면 근거 없는 가정이 된다(형태 모름 → defer, scratch.md 기록).
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { TuiEvent, ApprovalChoice } from "./model.js";
import type { GateDecision } from "../gate-core.js";
import type { EngineResult } from "../engine.js";

// ── SDK 메시지 → TuiEvent ──

export interface SdkMessageLike {
  type?: string;
  subtype?: string;
  total_cost_usd?: number;
  num_turns?: number;
}

/**
 * SDK 스트림 메시지를 TuiState 이벤트로 매핑한다. TURN_START는 여기서 다루지 않는다 —
 * 사용자가 제출(editor.ts commitSubmit)한 시점에 호출부가 직접 발화하는 것이 더 정확하다
 * (스트림 첫 메시지가 항상 "턴 시작"을 의미하지 않을 수 있음). result만 턴 종료 신호다.
 */
export function mapEngineMessageToTuiEvents(msg: SdkMessageLike): TuiEvent[] {
  if (msg.type === "result") {
    return [
      { type: "TURN_END" },
      { type: "STATUSLINE_UPDATE", patch: { costUsd: msg.total_cost_usd ?? 0 } },
    ];
  }
  return [];
}

// ── GateDecision → TuiEvent (gate-sdk.ts의 onDecision seam이 넘겨주는 판정) ──

/**
 * PreToolUse 판정(GateDecision)을 게이트 줄 이벤트로 매핑한다. block이면 그 순간 이미 사유 텍스트가
 * 있으므로 canUseTool의 decisionReason을 기다리지 않고 바로 APPROVAL_REQUESTED를 낸다 — SDK가 "ask"를
 * canUseTool로 라우팅할지는 하위 채널 문제고, 사유는 여기서 이미 확정돼 있다. block이 아닌 모든 판정
 * (pass/cached/doc-skip/bypass/fail-open/passthrough)은 사용자 관점에서 "통과"로 뭉뚱그린다 —
 * fail-open의 실패 고지는 SDK systemMessage(스크롤백)로 이미 별도 전달되므로 게이트 줄까지 이중고지하지
 * 않는다.
 * specCount·deferCount는 둘 다 GateDecision에서 읽지 않고 호출부가 넘긴다 — decision.event.deferCount는
 * pass/block kind에서만 채워지고(gate-core.ts) cached/doc-skip/bypass(작업단위 내 최다빈도 경로)엔 아예
 * 없어 ?? 0 폴백이 "실제 defer가 있어도 항상 0"으로 보이는 정확성 결함이 됐다(자체검토로 발견). 두
 * 카운트 모두 readSpecCases(cwd).length / activeDeferItems(cwd).length로 매번 새로 세는 것이 유일하게
 * 정확한 소스 — GateDecision의 event는 계측(events.jsonl) 목적이지 TUI 실시간 표시용이 아니다.
 */
export function buildGateResultEvent(decision: GateDecision, specCount: number, deferCount: number): TuiEvent {
  if (decision.kind === "block") {
    return { type: "APPROVAL_REQUESTED", reason: decision.output.permission?.reason ?? "" };
  }
  return { type: "GATE_RESULT", status: "pass", specCount, deferCount };
}

// ── 승인 프롬프트 분류 ──

export type ApprovalRequestContext =
  | { kind: "spec-add"; derivedCase: string; rawCommand: string }
  | { kind: "generic" };

const SPEC_ADD_RE = /^\s*gbc\s+spec\s+add\s+"([^"]*)"\s*$/;

/**
 * canUseTool로 들어온 도구 호출이 "게이트 BLOCK 해소용 spec add 도출"인지 분류한다.
 * Bash("gbc spec add \"...\"") 형태만 spec-add — 그 외(다른 Bash 명령·다른 도구)는
 * generic(기존 y/N 이진 pause로 폴백, A1 makeStdinPauseCanUseTool과 동일 취급).
 */
export function classifyApprovalRequest(
  toolName: string,
  input: Record<string, unknown>,
): ApprovalRequestContext {
  if (toolName !== "Bash") return { kind: "generic" };
  const command = typeof input.command === "string" ? input.command : "";
  const m = command.match(SPEC_ADD_RE);
  if (!m) return { kind: "generic" };
  return { kind: "spec-add", derivedCase: m[1], rawCommand: command };
}

// ── 승인 응답 해석 ──

export interface ApprovalResolution {
  result: PermissionResult;
  /** null이 아니면 호출부가 addDefer(cwd, deferText)를 실행해야 한다(이 함수는 I/O하지 않음). */
  deferText: string | null;
}

/**
 * y/n/e/d 선택을 SDK PermissionResult(이진 allow/deny)로 해석한다.
 * spec-add 컨텍스트: y=승인 그대로 · e=편집된 명령으로 승인(updatedInput 치환) ·
 *   n=거부 · d=거부+derivedCase를 defer 부작용으로 반환.
 * generic 컨텍스트: e/d는 편집·defer 대상(derivedCase)이 없으므로 n과 동일(고무도장 방지 기본값).
 */
export function resolveApproval(
  choice: ApprovalChoice,
  ctx: ApprovalRequestContext,
  input: Record<string, unknown>,
  editedCommand?: string,
): ApprovalResolution {
  const deny = (message: string): ApprovalResolution => ({ result: { behavior: "deny", message }, deferText: null });

  if (ctx.kind !== "spec-add") {
    if (choice === "y") return { result: { behavior: "allow", updatedInput: input }, deferText: null };
    return deny("사용자가 도구 실행을 거부함 (pause)");
  }

  switch (choice) {
    case "y":
      return { result: { behavior: "allow", updatedInput: input }, deferText: null };
    case "e": {
      const command = editedCommand ?? ctx.rawCommand;
      return { result: { behavior: "allow", updatedInput: { ...input, command } }, deferText: null };
    }
    case "d":
      return { result: { behavior: "deny", message: "사용자가 defer로 보류함 (pause)" }, deferText: ctx.derivedCase };
    case "n":
    default:
      return deny("사용자가 도구 실행을 거부함 (pause)");
  }
}

// ── runEngine 반환값 → TUI 표시 문구 ──

/**
 * runEngine()은 계약상 절대 rethrow하지 않고(engine.ts 주석 참조) isError/error를 담아 정상 반환한다.
 * app.tsx submit()이 이 반환값을 그대로 버리면 인증·네트워크 실패가 화면에 전혀 안 뜨는 "무응답"
 * 결함이 된다(0.9.1 실사용자 보고). 이 함수가 그 반환값을 표시 문구로 변환한다 — null이면 호출부가
 * 아무것도 pushLine하지 않는다.
 *
 * auth는 isError와 독립 채널이다 — SDKAuthStatusMessage(engine.ts:175)는 result 메시지·throw 어느
 * 쪽도 거치지 않고 error를 담아 종료될 수 있다(scope-critic 지적, cli.ts:1052가 이미 이 필드를 별도
 * 노출하는 선례). isError가 우선이고(더 구체적인 실패 사유), 그게 아닐 때만 auth.error를 본다.
 */
export function formatEngineFailure(
  result: Pick<EngineResult, "isError" | "error" | "auth">,
): string | null {
  if (result.isError) {
    return `🐢 오류: ${result.error ?? "알 수 없는 오류로 응답을 완료하지 못했습니다"}`;
  }
  if (result.auth?.error) {
    return `🐢 인증 오류: ${result.auth.error}`;
  }
  return null;
}
