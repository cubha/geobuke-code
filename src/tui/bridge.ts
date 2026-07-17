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
import { classifySpawnPermissionError } from "./startup-diagnostics.js";

// ── SDK 메시지 → TuiEvent ──

export interface SdkMessageLike {
  type?: string;
  subtype?: string;
  total_cost_usd?: number;
  num_turns?: number;
  /** ST7(0.9.4 T1 계측) — 첫 토큰까지 걸린 시간(ms). SDK result 메시지 필드(ST0 스파이크 실측 확인). */
  ttft_ms?: number;
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
      {
        type: "STATUSLINE_UPDATE",
        patch: {
          costUsd: msg.total_cost_usd ?? 0,
          // ST7 — ttft_ms 부재 시 patch에 아예 안 실음(기존 계약 보존, 0으로 덮어써 이전 값을
          // 지우지 않는다 — costUsd와 달리 매 result에 항상 있다는 보장이 없어 방어적으로 옵셔널).
          ...(typeof msg.ttft_ms === "number" ? { lastTtftMs: msg.ttft_ms } : {}),
        },
      },
    ];
  }
  return [];
}

// ── GateDecision → TuiEvent (gate-sdk.ts의 onDecision seam이 넘겨주는 판정) ──

/**
 * PreToolUse 판정(GateDecision)을 게이트 줄 이벤트로 매핑한다. block이면 그 순간 이미 사유 텍스트가
 * 있으므로 canUseTool의 decisionReason을 기다리지 않고 바로 APPROVAL_REQUESTED를 낸다 — SDK가 "ask"를
 * canUseTool로 라우팅할지는 하위 채널 문제고, 사유는 여기서 이미 확정돼 있다. block이 아닌 모든 판정
 * (pass/cached/doc-skip/bypass/fail-open/passthrough/block-repeat)은 사용자 관점에서 "통과"로 뭉뚱그린다 —
 * fail-open의 실패 고지, block-repeat(0.9.3 ST2 — 동일 missing 셋 재발화 강등)의 안내 문구 둘 다
 * emit-direct 공통 경로로 SDK systemMessage(스크롤백)에 이미 별도 전달되므로 게이트 줄까지
 * 이중고지하지 않는다. ⚠️ 신규 GateKind를 추가할 때는 이 목록에 명시로 넣을지 검토할 것 — 이 함수는
 * exhaustiveness 체크가 없어 목록 밖 kind는 else로 조용히 흡수된다(scope-critic 발견, 2026-07-14:
 * block-repeat 도입 시 이 함수를 검토하지 않아도 컴파일이 통과해 하마터면 미검토 상속이 될 뻔함).
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
    // spawn EPERM/EACCES(회사 보안정책의 claude 실행파일 차단, ST6)는 runEngine이 rethrow하지 않고
    // 이 error 문자열로만 반환한다 — classifyTuiStartupError(cli.ts cmdTui의 ink 로딩 크래시 경로)는
    // 이 경로를 못 보므로 여기서 직접 재사용해 GBC_CLAUDE_PATH 안내가 실제로 화면에 뜨게 한다.
    const diag = result.error ? classifySpawnPermissionError(result.error) : null;
    if (diag) return diag;
    return `🐢 오류: ${result.error ?? "알 수 없는 오류로 응답을 완료하지 못했습니다"}`;
  }
  if (result.auth?.error) {
    return `🐢 인증 오류: ${result.auth.error}`;
  }
  return null;
}

/**
 * ST1(0.9.2) Esc 중단은 사용자가 의도한 취소지 실패가 아니다 — formatEngineFailure(danger 톤
 * "🐢 오류:")와 같은 채널로 섞으면 정상 동작이 실패처럼 보인다. engine.ts가 aborted를 isError/error와
 * 배타로 채우므로(engine.ts catch 분기) 호출부는 이 함수를 formatEngineFailure보다 먼저 확인한다.
 */
export function formatEngineAbort(result: Pick<EngineResult, "aborted">): string | null {
  return result.aborted ? "🐢 중단됨 — 응답 생성을 취소했습니다" : null;
}

/**
 * 0.10.0 A3b ST5 — createEngineSessionWithResumeFallback이 resume 실패로 새 세션을 만들어
 * 재시도했을 때(EngineResult.resumeFallback) 사용자에게 정직하게 알리는 경계 배너. 이 배너 없이
 * 조용히 새 세션으로 넘어가면, 모델이 방금 전 대화를 기억 못 하는 게 "환각"처럼 보일 수 있다 —
 * 실제로는 세션 경계가 끊겼을 뿐임을 명시해 사용자의 오해를 막는다.
 */
export function formatResumeFallbackBanner(result: Pick<EngineResult, "resumeFallback">): string | null {
  if (!result.resumeFallback) return null;
  return `🐢 이전 세션(${result.resumeFallback.previousSessionId})을 이어받지 못해 새 세션으로 다시 시작했습니다 — 방금 전 대화는 기억하지 못합니다.`;
}

// ── 크래시 덤프 (0.10.0 A3b ST12) ──
// 알트스크린(ST10) 전환의 대가: ink는 teardown 프레임을 보존하지 않는다(공식 동작) — 종료 사유
// 불문(정상 종료·SIGINT·SIGTERM·uncaughtException) 화면이 그냥 사라진다. 대화 자체는 서버측
// resume(ST2/ST7)이 보존하지만, "화면에 뭐가 떠 있었는지"는 이 덤프가 유일한 복구 경로다.

export interface DumpableEntry {
  kind: string;
  text?: string;
}

/**
 * scrollback을 사람이 읽을 평문으로 직렬화한다(순수). hero/segments 엔트리는 복잡한 조립 구조라
 * (SplashHero/Segments) 텍스트로 완전 재구성하지 않고 생략한다 — 덤프의 목적은 "대화 내용 복구"지
 * 화면 재현이 아니다(text kind만도 실질 대화 내용은 전부 커버).
 */
export function formatCrashDump(entries: DumpableEntry[], reason: string, atIso: string): string {
  const lines = entries.filter((e) => e.kind === "text" && e.text).map((e) => e.text as string);
  const header = `🐢 gbc TUI 세션 종료 — ${reason} (${atIso})`;
  const divider = "=".repeat(Math.max(header.length, 20));
  return `${header}\n${divider}\n${lines.join("\n")}\n`;
}

// ── partial 스트리밍 델타 어셈블러 (0.9.4 ST3, T2) ──

/** stream_event 메시지에서 이 어셈블러가 읽는 필드만(SDKPartialAssistantMessage 최소 형상). */
interface StreamEventLike {
  type?: string;
  event?: {
    type?: string;
    index?: number;
    content_block?: { type?: string };
    delta?: { type?: string; text?: string };
  };
}

/**
 * stream_event(content_block_delta)를 content block index별로 누적해 "지금까지 텍스트"를 매
 * delta마다 반환한다. Static 커밋-후-불변 모델과의 공존 규율: 이 어셈블러는 진행 중 표시(호출부가
 * Static 밖 동적 영역에 렌더)만 책임지고 스스로 커밋하지 않는다 — 완성된 최종 텍스트의 커밋은
 * 기존 mapSdkMessage(assistant 메시지 경로)가 그대로 맡는다. 두 경로가 같은 텍스트를 각자
 * 스크롤백에 push하면 이중출력이 되므로(braintrust ⑥), 호출부(app.tsx, ST5)가 "델타 렌더 중엔
 * assistant 최종 텍스트를 그 자리에 교체 커밋"하는 단일 소스 규율을 지켜야 한다 — 이 클래스는
 * 그 규율을 강제하지 않고 재료(누적 텍스트)만 준다.
 *
 * text 블록만 추적한다(content_block_start.content_block.type === "text") — tool_use의
 * input_json_delta 등은 T2 스코프 밖(0.9.4 plan 비목표, 텍스트만).
 */
export class DeltaAssembler {
  private texts = new Map<number, string>();

  apply(msg: StreamEventLike): string | null {
    if (msg.type !== "stream_event" || !msg.event) return null;
    const ev = msg.event;
    const index = ev.index;

    if (ev.type === "content_block_start") {
      if (typeof index === "number" && ev.content_block?.type === "text") {
        this.texts.set(index, "");
      }
      return null;
    }

    if (ev.type === "content_block_delta" && typeof index === "number" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      if (!this.texts.has(index)) return null; // content_block_start로 text 블록임을 확인 못 했으면 추적 안 함
      const next = (this.texts.get(index) ?? "") + ev.delta.text;
      this.texts.set(index, next);
      return next;
    }

    if (ev.type === "content_block_stop" && typeof index === "number") {
      this.texts.delete(index); // 블록 완결 — 다음 턴이 같은 index를 재사용해도 안 섞이게 정리
      return null;
    }

    return null;
  }
}
