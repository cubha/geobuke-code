// 0.10.6 B1(TDD) — app.tsx useInput의 16단 키 우선순위 사다리(⌃C→Alt+탭→optOut확인→Alt+W→승인→
// 패널토글→?→패널열림→스크롤→슬래시→Tab포커스→사이드바포커스→Esc→shift+↵→↵→에디터폴백)를 순수
// 라우팅 함수 classifyKey로 고정한다. 이 계약을 먼저 잠근 뒤(RED→GREEN) app.tsx가 그 결과로
// 디스패치하도록 재배선한다(B2) — 재배선 자체가 이 계약을 어기면 여기서 즉시 드러난다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyKey } from "../dist/tui/keymap.js";

function ctx(overrides = {}) {
  return {
    exitConfirmArmed: false,
    hasApproval: false,
    approvalKind: null,
    approvalEditing: false,
    optOutConfirmArmed: false,
    isStartRepoTab: false,
    panel: "none",
    slashOpen: false,
    slashCandidateCount: 0,
    sidebarFocused: false,
    editorEmpty: true,
    ...overrides,
  };
}

function key(overrides = {}) {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    meta: false,
    backspace: false,
    delete: false,
    ...overrides,
  };
}

// ── 1단: Ctrl+C ──

test("Ctrl+C(미확정 상태) → ctrl-c-arm", () => {
  assert.deepEqual(classifyKey("c", key({ ctrl: true }), ctx()), { type: "ctrl-c-arm" });
});

test("Ctrl+C(확정 상태) → ctrl-c-exit", () => {
  assert.deepEqual(classifyKey("c", key({ ctrl: true }), ctx({ exitConfirmArmed: true })), { type: "ctrl-c-exit" });
});

test("Ctrl+C는 meta(Alt)로는 발동하지 않는다(ctrl 전용, 원본 코드 계약)", () => {
  const out = classifyKey("c", key({ meta: true }), ctx());
  assert.notEqual(out.type, "ctrl-c-arm");
  assert.notEqual(out.type, "ctrl-c-exit");
});

test("Ctrl+C는 승인·패널·사이드바포커스 중에도 최우선 발동(전역 우선순위)", () => {
  const out = classifyKey(
    "c",
    key({ ctrl: true }),
    ctx({ hasApproval: true, panel: "metrics", sidebarFocused: true }),
  );
  assert.equal(out.type, "ctrl-c-arm");
});

// ── 2단: Alt/Ctrl+1..9 탭 전환 ──

test("Alt+5 → tab-switch-direct index=4(0-base)", () => {
  assert.deepEqual(classifyKey("5", key({ meta: true }), ctx()), { type: "tab-switch-direct", index: 4 });
});

test("Ctrl+3 → tab-switch-direct index=2(kitty 지원 터미널 경로)", () => {
  assert.deepEqual(classifyKey("3", key({ ctrl: true }), ctx()), { type: "tab-switch-direct", index: 2 });
});

test("탭 전환은 승인 중에도 발동(승인이 다른 탭 전환을 막지 않는다)", () => {
  const out = classifyKey("3", key({ meta: true }), ctx({ hasApproval: true }));
  assert.deepEqual(out, { type: "tab-switch-direct", index: 2 });
});

// ── 3단: opt-out 확인 ──

test("opt-out 확인 중 'y' → opt-out-confirm-yes", () => {
  assert.deepEqual(classifyKey("y", key(), ctx({ optOutConfirmArmed: true })), { type: "opt-out-confirm-yes" });
});

test("opt-out 확인 중 그 외 입력 → opt-out-confirm-no", () => {
  assert.deepEqual(classifyKey("n", key(), ctx({ optOutConfirmArmed: true })), { type: "opt-out-confirm-no" });
  assert.deepEqual(classifyKey("x", key(), ctx({ optOutConfirmArmed: true })), { type: "opt-out-confirm-no" });
});

// ── 4단: Alt/Ctrl+W opt-out 시작 ──

test("Alt+W(승인 없음, 시작탭 아님) → opt-out-start", () => {
  assert.deepEqual(classifyKey("w", key({ meta: true }), ctx()), { type: "opt-out-start" });
});

test("Alt+W(시작 repo 탭) → opt-out-blocked", () => {
  assert.deepEqual(classifyKey("w", key({ meta: true }), ctx({ isStartRepoTab: true })), { type: "opt-out-blocked" });
});

test("Alt+W는 승인 중엔 발동하지 않는다(모호한 이중 y/n 방지) — approval-swallow로 낙하", () => {
  const out = classifyKey("w", key({ meta: true }), ctx({ hasApproval: true }));
  assert.equal(out.type, "approval-swallow");
});

// ── 5단: 승인 블록 ──

test("승인 편집 중 Enter → approval-edit-submit", () => {
  assert.deepEqual(
    classifyKey("", key({ return: true }), ctx({ hasApproval: true, approvalEditing: true })),
    { type: "approval-edit-submit" },
  );
});

test("승인 편집 중 Esc → approval-edit-cancel", () => {
  assert.deepEqual(
    classifyKey("", key({ escape: true }), ctx({ hasApproval: true, approvalEditing: true })),
    { type: "approval-edit-cancel" },
  );
});

test("승인 편집 중 일반 타이핑 → approval-edit-keystroke", () => {
  assert.deepEqual(
    classifyKey("x", key(), ctx({ hasApproval: true, approvalEditing: true })),
    { type: "approval-edit-keystroke" },
  );
});

test("승인 y/n/d → approval-answer", () => {
  for (const choice of ["y", "n", "d"]) {
    assert.deepEqual(classifyKey(choice, key(), ctx({ hasApproval: true })), { type: "approval-answer", choice });
  }
});

test("승인 'e'(kind=spec-add) → approval-open-edit", () => {
  assert.deepEqual(
    classifyKey("e", key(), ctx({ hasApproval: true, approvalKind: "spec-add" })),
    { type: "approval-open-edit" },
  );
});

test("승인 'e'(kind=generic) → approval-answer choice='e'(즉시 거부 처리, bridge.ts 계약)", () => {
  assert.deepEqual(
    classifyKey("e", key(), ctx({ hasApproval: true, approvalKind: "generic" })),
    { type: "approval-answer", choice: "e" },
  );
});

test("승인 중 좌우 화살표 → approval-selection-move", () => {
  assert.deepEqual(classifyKey("", key({ leftArrow: true }), ctx({ hasApproval: true })), {
    type: "approval-selection-move",
    direction: -1,
  });
  assert.deepEqual(classifyKey("", key({ rightArrow: true }), ctx({ hasApproval: true })), {
    type: "approval-selection-move",
    direction: 1,
  });
});

test("승인 중 Enter(선택 확정) → approval-confirm-selection", () => {
  assert.deepEqual(classifyKey("", key({ return: true }), ctx({ hasApproval: true })), {
    type: "approval-confirm-selection",
  });
});

test("승인 중 매칭 안 되는 키(임의 문자) → approval-swallow(카드리뷰 대상 밖 키도 삼킨다)", () => {
  assert.deepEqual(classifyKey("z", key(), ctx({ hasApproval: true })), { type: "approval-swallow" });
});

// ── 6단: 패널 토글(Alt/Ctrl+M/R/S/T) ──

test("Alt+M/R/S/T → toggle-panel/toggle-title", () => {
  assert.deepEqual(classifyKey("m", key({ meta: true }), ctx()), { type: "toggle-panel", panel: "metrics" });
  assert.deepEqual(classifyKey("r", key({ ctrl: true }), ctx()), { type: "toggle-panel", panel: "repos" });
  assert.deepEqual(classifyKey("s", key({ meta: true }), ctx()), { type: "toggle-panel", panel: "skills" });
  assert.deepEqual(classifyKey("t", key({ ctrl: true }), ctx()), { type: "toggle-title" });
});

// ── 7단: '?' 도움말(에디터 빈 상태 한정) ──

test("'?'(에디터 비어있음) → toggle-panel help", () => {
  assert.deepEqual(classifyKey("?", key(), ctx({ editorEmpty: true })), { type: "toggle-panel", panel: "help" });
});

test("'?'(에디터에 이미 텍스트 있음) → 도움말 아님, 일반 문자로 낙하(editor-keystroke)", () => {
  assert.deepEqual(classifyKey("?", key(), ctx({ editorEmpty: false })), { type: "editor-keystroke" });
});

// ── 8단: 패널 열림 중 라우팅 ──

test("패널 열림 중 Esc → panel-close", () => {
  assert.deepEqual(classifyKey("", key({ escape: true }), ctx({ panel: "metrics" })), { type: "panel-close" });
});

test("repos 패널 열림 중 ↑/↓/Enter → repos-panel-cursor/select", () => {
  assert.deepEqual(classifyKey("", key({ upArrow: true }), ctx({ panel: "repos" })), {
    type: "repos-panel-cursor",
    direction: -1,
  });
  assert.deepEqual(classifyKey("", key({ downArrow: true }), ctx({ panel: "repos" })), {
    type: "repos-panel-cursor",
    direction: 1,
  });
  assert.deepEqual(classifyKey("", key({ return: true }), ctx({ panel: "repos" })), { type: "repos-panel-select" });
});

test("metrics/skills/help 패널 중엔 화살표가 아무 것도 안 하고 그대로 삼킨다(repos 전용 기능)", () => {
  assert.deepEqual(classifyKey("", key({ upArrow: true }), ctx({ panel: "metrics" })), { type: "panel-swallow" });
});

test("패널 열림 중 매칭 안 되는 일반 키도 통째로 삼킨다(panel-swallow)", () => {
  assert.deepEqual(classifyKey("x", key(), ctx({ panel: "skills" })), { type: "panel-swallow" });
});

// ── 9단: 스크롤 ──

test("PageUp/PageDown → scroll", () => {
  assert.deepEqual(classifyKey("", key({ pageUp: true }), ctx()), { type: "scroll", direction: 1 });
  assert.deepEqual(classifyKey("", key({ pageDown: true }), ctx()), { type: "scroll", direction: -1 });
});

// ── 10단: 슬래시 드롭다운 ──

test("슬래시 열림 중 ↑/↓/Esc → slash-cursor/slash-suppress", () => {
  assert.deepEqual(classifyKey("", key({ upArrow: true }), ctx({ slashOpen: true })), {
    type: "slash-cursor",
    direction: -1,
  });
  assert.deepEqual(classifyKey("", key({ downArrow: true }), ctx({ slashOpen: true })), {
    type: "slash-cursor",
    direction: 1,
  });
  assert.deepEqual(classifyKey("", key({ escape: true }), ctx({ slashOpen: true })), { type: "slash-suppress" });
});

test("슬래시 열림 중 Tab은 후보 0개여도 항상 완성으로 소비한다(2026-07-24 버그수정 회귀 방지)", () => {
  assert.deepEqual(classifyKey("", key({ tab: true }), ctx({ slashOpen: true, slashCandidateCount: 0 })), {
    type: "slash-complete",
  });
});

test("슬래시 열림 중 Enter는 후보가 있을 때만 완성으로 소비한다", () => {
  assert.deepEqual(classifyKey("", key({ return: true }), ctx({ slashOpen: true, slashCandidateCount: 1 })), {
    type: "slash-complete",
  });
});

test("슬래시 열림 중 Enter+후보 0개는 완성하지 않고 낙하해 리터럴 텍스트 그대로 제출한다(editor-submit)", () => {
  assert.deepEqual(classifyKey("", key({ return: true }), ctx({ slashOpen: true, slashCandidateCount: 0 })), {
    type: "editor-submit",
  });
});

// ── 11단: Tab 사이드바 포커스 토글 ──

test("Tab(슬래시 닫힘) → sidebar-focus-toggle", () => {
  assert.deepEqual(classifyKey("", key({ tab: true }), ctx({ slashOpen: false })), { type: "sidebar-focus-toggle" });
});

// ── 12단: 사이드바 포커스 내비게이션 ──

test("사이드바 포커스 중 ↑/↓/Enter/Esc → sidebar-cursor/select/unfocus", () => {
  assert.deepEqual(classifyKey("", key({ upArrow: true }), ctx({ sidebarFocused: true })), {
    type: "sidebar-cursor",
    direction: -1,
  });
  assert.deepEqual(classifyKey("", key({ downArrow: true }), ctx({ sidebarFocused: true })), {
    type: "sidebar-cursor",
    direction: 1,
  });
  assert.deepEqual(classifyKey("", key({ return: true }), ctx({ sidebarFocused: true })), { type: "sidebar-select" });
  assert.deepEqual(classifyKey("", key({ escape: true }), ctx({ sidebarFocused: true })), { type: "sidebar-unfocus" });
});

test("사이드바 포커스 중 그 외 키(타이핑 등)는 통째로 삼킨다(sidebar-swallow)", () => {
  assert.deepEqual(classifyKey("x", key(), ctx({ sidebarFocused: true })), { type: "sidebar-swallow" });
});

// ── 13단: Esc(스트리밍 중단) ──

test("Esc(사이드바포커스·패널·슬래시 전부 비활성) → interrupt-stream", () => {
  assert.deepEqual(classifyKey("", key({ escape: true }), ctx()), { type: "interrupt-stream" });
});

// ── 14~15단: 개행/제출 ──

test("shift+Enter → editor-newline", () => {
  assert.deepEqual(classifyKey("", key({ return: true, shift: true }), ctx()), { type: "editor-newline" });
});

test("Enter(그 외 아무 상태도 아님) → editor-submit", () => {
  assert.deepEqual(classifyKey("", key({ return: true }), ctx()), { type: "editor-submit" });
});

// ── 16단: 폴백(일반 편집) ──

test("일반 타이핑·화살표는 editor-keystroke로 폴백한다", () => {
  assert.deepEqual(classifyKey("a", key(), ctx()), { type: "editor-keystroke" });
  assert.deepEqual(classifyKey("", key({ leftArrow: true }), ctx()), { type: "editor-keystroke" });
  assert.deepEqual(classifyKey("", key({ backspace: true }), ctx()), { type: "editor-keystroke" });
});
