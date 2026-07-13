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
}

export interface TuiState {
  splashShown: boolean;
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
}

const DEFAULT_STATUSLINE: Statusline = {
  dir: "",
  branch: "",
  dirty: false,
  model: "",
  usagePct: 0,
  costUsd: 0,
  lastTurnMs: 0,
};

export function createInitialState(statuslineSeed?: Partial<Statusline>): TuiState {
  return {
    splashShown: false,
    streaming: false,
    gateStatus: "idle",
    specCount: 0,
    deferCount: 0,
    panel: "none",
    approval: null,
    statusline: { ...DEFAULT_STATUSLINE, ...statuslineSeed },
    exitConfirmArmed: false,
  };
}

export type TuiEvent =
  | { type: "SESSION_START" }
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
  | { type: "CTRL_C_RESET" };

function cycleChoice(current: ApprovalChoice, direction: 1 | -1): ApprovalChoice {
  const idx = APPROVAL_CHOICES.indexOf(current);
  const next = (idx + direction + APPROVAL_CHOICES.length) % APPROVAL_CHOICES.length;
  return APPROVAL_CHOICES[next];
}

export function reduce(state: TuiState, event: TuiEvent): TuiState {
  switch (event.type) {
    case "SESSION_START":
      return { ...state, splashShown: true };

    case "TURN_START":
      return { ...state, streaming: true };

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

    default:
      return state;
  }
}
