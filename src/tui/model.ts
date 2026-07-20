// 0.9.0 A3a ST1 — 렌더-비의존 순수 상태모델(reducer).
// Ground Truth: gbc-tui-design.html 시안 A(A-⓪~A-④) + statusline 표 + 키맵 표.
// Ink/React를 import하지 않는다 — TUI 컴포넌트(ST5)가 이 reducer를 소비한다.

export type Panel = "none" | "metrics" | "repos" | "skills";
export type ApprovalChoice = "y" | "n" | "e" | "d";

export const APPROVAL_CHOICES: readonly ApprovalChoice[] = ["y", "n", "e", "d"];

export interface ApprovalState {
  reason: string;
  /** spec-add = 에이전트의 Bash("gbc spec add ...") 자기발화 승인(e/d 유효) · generic = 그 외 도구
   *  승인(derivedCase 없음, e/d는 n과 동일 — bridge.ts resolveApproval과 대칭). 미지정 시 generic. */
  kind: "spec-add" | "generic";
  derivedCase: string | null;
  selection: ApprovalChoice;
}

export interface Statusline {
  dir: string;
  branch: string;
  dirty: boolean;
  model: string;
  usagePct: number;
  costUsd: number;
  /** ST15(0.9.2) — 마지막으로 종료된 턴의 소요시간(ms). 0이면 아직 턴이 없었음(표시 생략 신호). */
  lastTurnMs: number;
  /** ST7(0.9.4 T1) — 마지막 턴의 첫 토큰까지 걸린 시간(ms, SDK result.ttft_ms). 0이면 아직 턴이
   *  없었거나 세션 재사용으로 체감 단축된 걸 실측할 값(성공기준 ⓐ) — 표시 생략 신호는 lastTurnMs와 동일. */
  lastTtftMs: number;
}

export interface TuiState {
  /** 0.10.1 — 첫 메시지 제출(TURN_START)로 한 번 true가 되면 이후 어떤 이벤트에도 되돌지 않는다
   *  (스플래시 일괄소멸 계약). SESSION_START/splashShown은 "마운트 시 1회 커밋"이라는 다른 계약을
   *  표현했던 구 필드로, 스플래시가 Static 밖 조건부 렌더로 옮겨가며 폐기됐다(app.tsx가 splashDismissed
   *  자체를 렌더 조건으로 직접 소비 — 더 이상 "커밋됐다"는 것만 기록하는 1회성 플래그가 아니다). */
  splashDismissed: boolean;
  streaming: boolean;
  gateStatus: "idle" | "pass" | "block";
  specCount: number;
  deferCount: number;
  panel: Panel;
  approval: ApprovalState | null;
  statusline: Statusline;
  /** ST9(0.9.2) Ctrl+C 2단 확인종료 — "일정 시간 내 두 번째 입력이면 종료"의 타이머 판단은 app.tsx
   *  (setTimeout, ST10)가 impure하게 맡고, 이 reducer는 armed 여부만 순수하게 추적한다. */
  exitConfirmArmed: boolean;
  /** ST4(0.9.4 T2) — bridge.ts DeltaAssembler.apply()가 반환한 누적 텍스트. Static 밖 동적 영역이
   *  이 필드만 보고 렌더한다(진행 중 표시 전용). 완성되면 app.tsx가 Static에 커밋 후 STREAM_COMMIT으로
   *  비운다 — 어셈블러가 이미 누적해서 주므로 reducer는 append가 아니라 단순 교체다. */
  streamingText: string;
}

const DEFAULT_STATUSLINE: Statusline = {
  dir: "",
  branch: "",
  dirty: false,
  model: "",
  usagePct: 0,
  costUsd: 0,
  lastTurnMs: 0,
  lastTtftMs: 0,
};

export function createInitialState(statuslineSeed?: Partial<Statusline>): TuiState {
  return {
    splashDismissed: false,
    streaming: false,
    gateStatus: "idle",
    specCount: 0,
    deferCount: 0,
    panel: "none",
    approval: null,
    statusline: { ...DEFAULT_STATUSLINE, ...statuslineSeed },
    exitConfirmArmed: false,
    streamingText: "",
  };
}

export type TuiEvent =
  | { type: "TURN_START" }
  | { type: "TURN_END" }
  | { type: "GATE_RESULT"; status: "pass" | "block"; specCount: number; deferCount: number }
  | { type: "APPROVAL_REQUESTED"; reason: string; kind?: "spec-add" | "generic" }
  | { type: "APPROVAL_CASE_DERIVED"; caseText: string }
  | { type: "APPROVAL_SELECTION_MOVE"; direction: 1 | -1 }
  | { type: "APPROVAL_ANSWERED"; choice: ApprovalChoice }
  | { type: "TOGGLE_PANEL"; panel: Exclude<Panel, "none"> }
  | { type: "CLOSE_PANEL" }
  | { type: "STATUSLINE_UPDATE"; patch: Partial<Statusline> }
  | { type: "CTRL_C_PRESSED" }
  | { type: "CTRL_C_RESET" }
  | { type: "STREAM_DELTA"; text: string }
  | { type: "STREAM_COMMIT" }
  // 0.10.0 A3b ST11 — 활성 탭 전환. TuiState는 "지금 포커스된 탭의 라이브 뷰"만 표현하므로(tabs.ts
  // 설계 주석 참조), 다른 repo로 전환하면 그 뷰 전체를 새 탭 기준으로 다시 시드한다(스트리밍·승인·
  // 게이트 상태는 절대 이어받지 않는다 — 다른 세션의 진행 상태를 여기 남기면 그 자체가 교차오염
  // 표면이 된다). scrollback 초기화는 app.tsx 책임(이 reducer는 TuiState만 다룸).
  | { type: "TAB_SWITCHED"; dir: string; branch: string; dirty: boolean; model: string; specCount: number; deferCount: number };

function cycleChoice(current: ApprovalChoice, direction: 1 | -1): ApprovalChoice {
  const idx = APPROVAL_CHOICES.indexOf(current);
  const next = (idx + direction + APPROVAL_CHOICES.length) % APPROVAL_CHOICES.length;
  return APPROVAL_CHOICES[next];
}

export function reduce(state: TuiState, event: TuiEvent): TuiState {
  switch (event.type) {
    case "TURN_START":
      // streamingText도 함께 리셋 — 직전 턴이 STREAM_COMMIT 없이 끝났을 경우(중단 등)의 방어.
      // splashDismissed:true — 첫 제출 시 스플래시 일괄소멸(0.10.1). 이미 true여도 재대입은 멱등.
      return { ...state, streaming: true, streamingText: "", splashDismissed: true };

    case "TURN_END":
      return { ...state, streaming: false };

    case "GATE_RESULT":
      return {
        ...state,
        gateStatus: event.status,
        specCount: event.specCount,
        deferCount: event.deferCount,
      };

    case "APPROVAL_REQUESTED":
      return {
        ...state,
        gateStatus: "block",
        panel: "none",
        approval: { reason: event.reason, kind: event.kind ?? "generic", derivedCase: null, selection: "y" },
      };

    case "APPROVAL_CASE_DERIVED":
      if (!state.approval) return state;
      return { ...state, approval: { ...state.approval, derivedCase: event.caseText } };

    case "APPROVAL_SELECTION_MOVE":
      if (!state.approval) return state;
      return {
        ...state,
        approval: { ...state.approval, selection: cycleChoice(state.approval.selection, event.direction) },
      };

    case "APPROVAL_ANSWERED":
      return { ...state, approval: null, gateStatus: "idle", streaming: true };

    case "TOGGLE_PANEL":
      return { ...state, panel: state.panel === event.panel ? "none" : event.panel };

    case "CLOSE_PANEL":
      return state.panel === "none" ? state : { ...state, panel: "none" };

    case "STATUSLINE_UPDATE":
      return { ...state, statusline: { ...state.statusline, ...event.patch } };

    case "CTRL_C_PRESSED":
      return state.exitConfirmArmed ? state : { ...state, exitConfirmArmed: true };

    case "CTRL_C_RESET":
      return state.exitConfirmArmed ? { ...state, exitConfirmArmed: false } : state;

    case "STREAM_DELTA":
      return { ...state, streamingText: event.text };

    case "STREAM_COMMIT":
      return state.streamingText === "" ? state : { ...state, streamingText: "" };

    case "TAB_SWITCHED": {
      // createInitialState를 그대로 재사용해 "새 탭 = 완전히 새 라이브 뷰" 계약을 한 곳에서만
      // 정의한다(App 마운트 시드 로직과 동일 조립 방식 — app.tsx가 중복 구현하지 않음).
      const base = createInitialState({ dir: event.dir, branch: event.branch, dirty: event.dirty, model: event.model });
      return { ...base, specCount: event.specCount, deferCount: event.deferCount, splashDismissed: true };
    }

    default:
      return state;
  }
}
