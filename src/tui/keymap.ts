// 0.10.6 B1 — app.tsx useInput의 키 우선순위 판정을 순수 함수로 분리한다. 원본은 240여 줄 단일
// 콜백 안에 16단 우선순위 사다리(⌃C→Alt+탭→optOut확인→Alt+W→승인→패널토글→?→패널열림→스크롤→
// 슬래시→Tab포커스→사이드바포커스→Esc→shift+↵→↵→에디터폴백)가 순서에 강하게 의존한 채 뒤섞여
// 있어(dispatch·pushLine·switchToTab 등 부수효과와 라우팅 판단이 한 몸) 회귀 위험 없이 손대기
// 어려웠다. classifyKey는 "무엇을 할지"만 판단해 KeyAction으로 반환하고, "어떻게 할지"(부수효과)는
// app.tsx가 그대로 담당한다 — 판단 로직만 여기로 옮기고 각 케이스의 실제 동작(dispatch 호출 등)은
// 원본 순서·조건을 한 글자도 바꾸지 않고 그대로 재현한다(RED-first 계약, test/tui-keymap.test.mjs).
import type { Key } from "ink";
import type { ApprovalChoice } from "./model.js";

export type PanelKind = "none" | "metrics" | "repos" | "skills" | "help";

/** classifyKey가 판단에 필요로 하는 최소 컨텍스트 — 전부 app.tsx가 이미 들고 있는 상태값이다.
 * repos 배열·cursor 값 자체(어떤 repo를 가리키는지)는 여기 없다 — 그 인덱싱은 loadRepos() I/O를
 * 동반해 app.tsx의 액션 처리 쪽에 남는다(classifyKey는 fs 접근 없는 순수 함수). */
export interface KeyRoutingContext {
  exitConfirmArmed: boolean;
  hasApproval: boolean;
  /** hasApproval=false면 무의미. */
  approvalKind: "spec-add" | "generic" | null;
  approvalEditing: boolean;
  optOutConfirmArmed: boolean;
  /** Alt+W 차단 판정(시작 repo 탭은 opt-out 불가). */
  isStartRepoTab: boolean;
  panel: PanelKind;
  slashOpen: boolean;
  slashCandidateCount: number;
  sidebarFocused: boolean;
  editorEmpty: boolean;
}

export type KeyAction =
  | { type: "ctrl-c-arm" }
  | { type: "ctrl-c-exit" }
  | { type: "tab-switch-direct"; index: number }
  | { type: "opt-out-confirm-yes" }
  | { type: "opt-out-confirm-no" }
  | { type: "opt-out-blocked" }
  | { type: "opt-out-start" }
  | { type: "approval-edit-submit" }
  | { type: "approval-edit-cancel" }
  | { type: "approval-edit-keystroke" }
  | { type: "approval-answer"; choice: ApprovalChoice }
  | { type: "approval-open-edit" }
  | { type: "approval-selection-move"; direction: -1 | 1 }
  | { type: "approval-confirm-selection" }
  | { type: "approval-swallow" }
  | { type: "toggle-panel"; panel: "metrics" | "repos" | "skills" | "help" }
  | { type: "toggle-title" }
  | { type: "panel-close" }
  | { type: "repos-panel-cursor"; direction: -1 | 1 }
  | { type: "repos-panel-select" }
  | { type: "panel-swallow" }
  | { type: "scroll"; direction: -1 | 1 }
  | { type: "slash-cursor"; direction: -1 | 1 }
  | { type: "slash-suppress" }
  | { type: "slash-complete" }
  | { type: "sidebar-focus-toggle" }
  | { type: "sidebar-cursor"; direction: -1 | 1 }
  | { type: "sidebar-select" }
  | { type: "sidebar-unfocus" }
  | { type: "sidebar-swallow" }
  | { type: "interrupt-stream" }
  | { type: "editor-newline" }
  | { type: "editor-submit" }
  | { type: "editor-keystroke" };

/** app.tsx useInput 콜백의 16단 우선순위 사다리(순수 판정). 원본 순서를 그대로 보존한다 — 순서를
 * 바꾸면 계약이 깨진다(예: ⌃C는 항상 최우선, 탭 전환은 승인보다 우선, 슬래시 Tab은 후보 0개여도
 * 항상 소비). */
export function classifyKey(input: string, key: Key, ctx: KeyRoutingContext): KeyAction {
  // 1단 — Ctrl+C 2단 확인 종료(meta 폴백 없음, ctrl 전용).
  if (key.ctrl && input === "c") {
    return ctx.exitConfirmArmed ? { type: "ctrl-c-exit" } : { type: "ctrl-c-arm" };
  }

  // 2단 — Alt/Ctrl+1..9 탭 전환(승인·패널보다 우선 — critic 지적, 승인이 탭 전환을 막지 않게).
  if ((key.ctrl || key.meta) && /^[1-9]$/.test(input)) {
    return { type: "tab-switch-direct", index: Number.parseInt(input, 10) - 1 };
  }

  // 3단 — opt-out 확인 대기(y/그 외).
  if (ctx.optOutConfirmArmed) {
    return input === "y" ? { type: "opt-out-confirm-yes" } : { type: "opt-out-confirm-no" };
  }

  // 4단 — Alt/Ctrl+W opt-out 시작(승인 중엔 시작 안 함 — 이중 y/n 확인 모호성 방지).
  if ((key.ctrl || key.meta) && input === "w" && !ctx.hasApproval) {
    return ctx.isStartRepoTab ? { type: "opt-out-blocked" } : { type: "opt-out-start" };
  }

  // 5단 — 승인 블록(도달하면 항상 무언가를 반환해 이후 단계로 흘리지 않는다 — 원본의 무조건 return과 동치).
  if (ctx.hasApproval) {
    if (ctx.approvalEditing) {
      if (key.return) return { type: "approval-edit-submit" };
      if (key.escape) return { type: "approval-edit-cancel" };
      return { type: "approval-edit-keystroke" };
    }
    if (input === "y" || input === "n" || input === "d") {
      return { type: "approval-answer", choice: input as ApprovalChoice };
    }
    if (input === "e") {
      return ctx.approvalKind === "spec-add" ? { type: "approval-open-edit" } : { type: "approval-answer", choice: "e" };
    }
    if (key.leftArrow) return { type: "approval-selection-move", direction: -1 };
    if (key.rightArrow) return { type: "approval-selection-move", direction: 1 };
    if (key.return) return { type: "approval-confirm-selection" };
    return { type: "approval-swallow" };
  }

  // 6단 — 패널 토글(Alt/Ctrl+M/R/S) + 타이틀 토글(Alt/Ctrl+T).
  if ((key.ctrl || key.meta) && input === "m") return { type: "toggle-panel", panel: "metrics" };
  if ((key.ctrl || key.meta) && input === "r") return { type: "toggle-panel", panel: "repos" };
  if ((key.ctrl || key.meta) && input === "s") return { type: "toggle-panel", panel: "skills" };
  if ((key.ctrl || key.meta) && input === "t") return { type: "toggle-title" };

  // 7단 — '?' 도움말(에디터가 비어있을 때만 — 아니면 일반 문자로 낙하해 아래 폴백에 잡힌다).
  if (input === "?" && ctx.editorEmpty) return { type: "toggle-panel", panel: "help" };

  // 8단 — 패널 열림 중 라우팅(도달하면 항상 무언가를 반환 — 원본의 무조건 return과 동치).
  if (ctx.panel !== "none") {
    if (key.escape) return { type: "panel-close" };
    if (ctx.panel === "repos") {
      if (key.upArrow) return { type: "repos-panel-cursor", direction: -1 };
      if (key.downArrow) return { type: "repos-panel-cursor", direction: 1 };
      if (key.return) return { type: "repos-panel-select" };
    }
    return { type: "panel-swallow" };
  }

  // 9단 — 대화창 스크롤.
  if (key.pageUp) return { type: "scroll", direction: 1 };
  if (key.pageDown) return { type: "scroll", direction: -1 };

  // 10단 — 슬래시 드롭다운(Tab은 후보 유무 무관 항상 소비, Enter는 후보 있을 때만 — 없으면 낙하).
  if (ctx.slashOpen) {
    if (key.upArrow) return { type: "slash-cursor", direction: -1 };
    if (key.downArrow) return { type: "slash-cursor", direction: 1 };
    if (key.escape) return { type: "slash-suppress" };
    if (key.tab) return { type: "slash-complete" };
    if (key.return && ctx.slashCandidateCount > 0) return { type: "slash-complete" };
  }

  // 11단 — Tab 사이드바 포커스 토글(슬래시가 이미 Tab을 소비하지 않았을 때만 도달).
  if (key.tab) return { type: "sidebar-focus-toggle" };

  // 12단 — 사이드바 포커스 내비게이션(도달하면 항상 무언가를 반환 — 원본의 무조건 return과 동치).
  if (ctx.sidebarFocused) {
    if (key.upArrow) return { type: "sidebar-cursor", direction: -1 };
    if (key.downArrow) return { type: "sidebar-cursor", direction: 1 };
    if (key.return) return { type: "sidebar-select" };
    if (key.escape) return { type: "sidebar-unfocus" };
    return { type: "sidebar-swallow" };
  }

  // 13단 — Esc 스트리밍 중단(실제 streaming 여부 판단은 app.tsx가 한다 — sessionsRef 접근 필요).
  if (key.escape) return { type: "interrupt-stream" };

  // 14~15단 — 개행/제출.
  if (key.return && key.shift) return { type: "editor-newline" };
  if (key.return) return { type: "editor-submit" };

  // 16단 — 폴백(일반 편집: 타이핑·화살표·backspace/delete 등 applyEditorKey가 처리).
  return { type: "editor-keystroke" };
}
