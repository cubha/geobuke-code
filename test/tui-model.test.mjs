// 0.9.0 A3a ST1 — src/tui/model.ts 순수 상태모델(reducer) 단정.
// 렌더-비의존: Ink/React 없이 이벤트→다음상태 전이만 검증한다.
// Ground Truth: gbc-tui-design.html 시안 A(A-⓪~A-④)+statusline 표+키맵 표.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, reduce, APPROVAL_CHOICES } from "../dist/tui/model.js";

test("createInitialState: splashShown=false·gateStatus=idle·panel=none·approval=null", () => {
  const s = createInitialState();
  assert.equal(s.splashShown, false);
  assert.equal(s.streaming, false);
  assert.equal(s.gateStatus, "idle");
  assert.equal(s.panel, "none");
  assert.equal(s.approval, null);
  assert.equal(s.specCount, 0);
  assert.equal(s.deferCount, 0);
});

test("createInitialState(seed): statusline 시드값 병합", () => {
  const s = createInitialState({ dir: "~/workspace/geobuke-code", model: "sonnet" });
  assert.equal(s.statusline.dir, "~/workspace/geobuke-code");
  assert.equal(s.statusline.model, "sonnet");
  assert.equal(s.statusline.usagePct, 0, "미시드 필드는 기본값 유지");
  assert.equal(s.statusline.lastTurnMs, 0, "ST15 — 아직 턴 없음 기본값");
});

test("STATUSLINE_UPDATE: lastTurnMs(0.9.2 ST15)도 다른 필드와 동일하게 부분 병합", () => {
  let s = createInitialState();
  s = reduce(s, { type: "STATUSLINE_UPDATE", patch: { lastTurnMs: 12345 } });
  assert.equal(s.statusline.lastTurnMs, 12345);
  assert.equal(s.statusline.costUsd, 0, "무관 필드 보존");
});

test("createInitialState: lastTtftMs 기본값 0(0.9.4 ST7 계측 — 아직 턴 없음)", () => {
  const s = createInitialState();
  assert.equal(s.statusline.lastTtftMs, 0);
});

test("STATUSLINE_UPDATE: lastTtftMs(0.9.4 ST7)도 다른 필드와 동일하게 부분 병합", () => {
  let s = createInitialState();
  s = reduce(s, { type: "STATUSLINE_UPDATE", patch: { lastTtftMs: 1660 } });
  assert.equal(s.statusline.lastTtftMs, 1660);
  assert.equal(s.statusline.lastTurnMs, 0, "무관 필드 보존");
});

test("SESSION_START: splashShown을 true로(스플래시 1회 커밋 계약)", () => {
  const s = reduce(createInitialState(), { type: "SESSION_START" });
  assert.equal(s.splashShown, true);
});

test("TURN_START/TURN_END: streaming 토글", () => {
  let s = createInitialState();
  s = reduce(s, { type: "TURN_START" });
  assert.equal(s.streaming, true);
  s = reduce(s, { type: "TURN_END" });
  assert.equal(s.streaming, false);
});

test("GATE_RESULT: gateStatus·spec/defer 카운트 갱신, streaming은 무변경", () => {
  let s = createInitialState();
  s = reduce(s, { type: "TURN_START" });
  s = reduce(s, { type: "GATE_RESULT", status: "pass", specCount: 4, deferCount: 2 });
  assert.equal(s.gateStatus, "pass");
  assert.equal(s.specCount, 4);
  assert.equal(s.deferCount, 2);
  assert.equal(s.streaming, true, "gate 판정 자체는 스트리밍을 끊지 않음(A-① — 도구 실행 옆 인라인)");
});

test("APPROVAL_REQUESTED: gateStatus=block·approval 생성(reason만, derivedCase=null, selection=y)·열려있던 패널 닫힘", () => {
  let s = createInitialState();
  s = reduce(s, { type: "TOGGLE_PANEL", panel: "metrics" });
  assert.equal(s.panel, "metrics");
  s = reduce(s, { type: "APPROVAL_REQUESTED", reason: "명세에 없는 파일 편집: 붙여넣기 처리 시나리오 미지정" });
  assert.equal(s.gateStatus, "block");
  assert.equal(s.approval.reason, "명세에 없는 파일 편집: 붙여넣기 처리 시나리오 미지정");
  assert.equal(s.approval.derivedCase, null);
  assert.equal(s.approval.selection, "y", "A-② 목업 기본 선택 = 승인(y)");
  assert.equal(s.panel, "none", "승인 프롬프트와 패널은 동시에 뜨지 않음(목업에 동시노출 없음)");
  assert.equal(s.approval.kind, "generic", "kind 미지정 시 기본값 generic(ST5 자체검토로 추가)");
});

test("APPROVAL_REQUESTED: kind:'spec-add' 명시 시 approval.kind에 그대로 반영(bridge.ts ApprovalRequestContext.kind와 대칭)", () => {
  const s = reduce(createInitialState(), { type: "APPROVAL_REQUESTED", reason: "r", kind: "spec-add" });
  assert.equal(s.approval.kind, "spec-add");
});

test("APPROVAL_CASE_DERIVED: approval.derivedCase 채움(엔진 도출 완료)", () => {
  let s = createInitialState();
  s = reduce(s, { type: "APPROVAL_REQUESTED", reason: "r" });
  s = reduce(s, { type: "APPROVAL_CASE_DERIVED", caseText: 'bracketed paste 수신 시 멀티라인 원문 그대로 삽입' });
  assert.equal(s.approval.derivedCase, "bracketed paste 수신 시 멀티라인 원문 그대로 삽입");
});

test("APPROVAL_CASE_DERIVED: approval 없을 때는 no-op(방어)", () => {
  const s0 = createInitialState();
  const s1 = reduce(s0, { type: "APPROVAL_CASE_DERIVED", caseText: "x" });
  assert.equal(s1.approval, null);
});

test("APPROVAL_SELECTION_MOVE: y→n→e→d→y 순환(키맵 순서), 역방향도 순환", () => {
  let s = createInitialState();
  s = reduce(s, { type: "APPROVAL_REQUESTED", reason: "r" });
  assert.deepEqual([...APPROVAL_CHOICES], ["y", "n", "e", "d"]);
  s = reduce(s, { type: "APPROVAL_SELECTION_MOVE", direction: 1 });
  assert.equal(s.approval.selection, "n");
  s = reduce(s, { type: "APPROVAL_SELECTION_MOVE", direction: 1 });
  s = reduce(s, { type: "APPROVAL_SELECTION_MOVE", direction: 1 });
  assert.equal(s.approval.selection, "d");
  s = reduce(s, { type: "APPROVAL_SELECTION_MOVE", direction: 1 });
  assert.equal(s.approval.selection, "y", "d 다음은 순환해 y");
  s = reduce(s, { type: "APPROVAL_SELECTION_MOVE", direction: -1 });
  assert.equal(s.approval.selection, "d", "역방향 순환");
});

test("APPROVAL_ANSWERED: approval=null·gateStatus=idle(재판정 대기)·streaming=true(엔진 재개)", () => {
  let s = createInitialState();
  s = reduce(s, { type: "APPROVAL_REQUESTED", reason: "r" });
  s = reduce(s, { type: "APPROVAL_ANSWERED", choice: "y" });
  assert.equal(s.approval, null);
  assert.equal(s.gateStatus, "idle");
  assert.equal(s.streaming, true);
});

test("TOGGLE_PANEL: 같은 패널 재입력 시 닫힘(none), 다른 패널이면 전환", () => {
  let s = createInitialState();
  s = reduce(s, { type: "TOGGLE_PANEL", panel: "metrics" });
  assert.equal(s.panel, "metrics");
  s = reduce(s, { type: "TOGGLE_PANEL", panel: "metrics" });
  assert.equal(s.panel, "none", "⌃M 재입력 = 닫기");
  s = reduce(s, { type: "TOGGLE_PANEL", panel: "repos" });
  assert.equal(s.panel, "repos");
  s = reduce(s, { type: "TOGGLE_PANEL", panel: "metrics" });
  assert.equal(s.panel, "metrics", "다른 패널 키 = 전환(둘 다 동시 노출 없음)");
});

test("CLOSE_PANEL: Esc — 열린 패널을 무조건 닫음, panel=none이면 no-op", () => {
  let s = createInitialState();
  s = reduce(s, { type: "CLOSE_PANEL" });
  assert.equal(s.panel, "none");
  s = reduce(s, { type: "TOGGLE_PANEL", panel: "repos" });
  s = reduce(s, { type: "CLOSE_PANEL" });
  assert.equal(s.panel, "none");
});

test("STATUSLINE_UPDATE: 부분 갱신(patch)만 병합, 나머지 필드 보존(턴 단위 갱신 계약)", () => {
  let s = createInitialState({ dir: "~/workspace/geobuke-code", branch: "main", model: "sonnet" });
  s = reduce(s, { type: "STATUSLINE_UPDATE", patch: { usagePct: 47, costUsd: 0.42 } });
  assert.equal(s.statusline.usagePct, 47);
  assert.equal(s.statusline.costUsd, 0.42);
  assert.equal(s.statusline.dir, "~/workspace/geobuke-code", "미포함 필드는 보존");
  assert.equal(s.statusline.branch, "main");
});

test("reduce는 입력 state를 변형하지 않는다(불변성 — 순수함수 계약)", () => {
  const s0 = createInitialState();
  const frozen = JSON.stringify(s0);
  reduce(s0, { type: "TURN_START" });
  assert.equal(JSON.stringify(s0), frozen, "원본 state 불변");
});

// ── Ctrl+C 2단 확인종료 (0.9.2 ST9) — "몇 초 내 두 번째 눌러야 종료"의 타이머 판단은 app.tsx(ST10,
// setTimeout)가 impure하게 담당하고, 이 reducer는 순수하게 "armed 여부"만 추적한다. ──

test("createInitialState: exitConfirmArmed=false(기본)", () => {
  assert.equal(createInitialState().exitConfirmArmed, false);
});

test("CTRL_C_PRESSED: exitConfirmArmed를 true로(다른 필드 무변경)", () => {
  const s0 = createInitialState({ model: "sonnet" });
  const s1 = reduce(s0, { type: "CTRL_C_PRESSED" });
  assert.equal(s1.exitConfirmArmed, true);
  assert.equal(s1.statusline.model, "sonnet", "무관 필드 보존");
});

test("CTRL_C_PRESSED: 이미 armed여도 멱등(다시 true)", () => {
  let s = createInitialState();
  s = reduce(s, { type: "CTRL_C_PRESSED" });
  s = reduce(s, { type: "CTRL_C_PRESSED" });
  assert.equal(s.exitConfirmArmed, true);
});

test("CTRL_C_RESET: exitConfirmArmed를 false로(타임아웃 경과 시 app.tsx가 발화)", () => {
  let s = createInitialState();
  s = reduce(s, { type: "CTRL_C_PRESSED" });
  s = reduce(s, { type: "CTRL_C_RESET" });
  assert.equal(s.exitConfirmArmed, false);
});

// ===== streamingText (0.9.4 ST4 — T2 partial 스트리밍 동적 영역) =====
// bridge.ts DeltaAssembler.apply()가 반환하는 "누적 텍스트"를 그대로 담는 슬롯. Static 밖 동적
// 영역이 이 필드 하나만 보고 렌더한다 — 완성되면 app.tsx가 Static에 커밋하고 STREAM_COMMIT으로
// 이 슬롯을 비운다(이중출력 방지, braintrust ⑥과 동일 규율을 상태모델 쪽에서 지지).

test("createInitialState: streamingText 기본값 빈 문자열", () => {
  const s = createInitialState();
  assert.equal(s.streamingText, "");
});

test("STREAM_DELTA: streamingText를 이벤트의 누적 텍스트로 교체(append 아님 — 어셈블러가 이미 누적해서 줌)", () => {
  let s = createInitialState();
  s = reduce(s, { type: "STREAM_DELTA", text: "안" });
  assert.equal(s.streamingText, "안");
  s = reduce(s, { type: "STREAM_DELTA", text: "안녕" });
  assert.equal(s.streamingText, "안녕", "누적은 어셈블러 책임 — reducer는 그냥 교체");
});

test("STREAM_COMMIT: streamingText를 빈 문자열로 비움(Static 커밋 직후 app.tsx가 발화)", () => {
  let s = createInitialState();
  s = reduce(s, { type: "STREAM_DELTA", text: "완성된 텍스트" });
  s = reduce(s, { type: "STREAM_COMMIT" });
  assert.equal(s.streamingText, "");
});

// ===== TAB_SWITCHED (0.10.0 A3b ST11 — 다중탭 전환 시 라이브 뷰 전체 재시드) =====

test("TAB_SWITCHED: 새 탭 기준 statusline·spec/defer로 완전히 재시드", () => {
  let s = createInitialState({ dir: "/repo/a", branch: "main", model: "sonnet" });
  s = reduce(s, { type: "TAB_SWITCHED", dir: "/repo/b", branch: "dev", dirty: true, model: "haiku", specCount: 3, deferCount: 1 });
  assert.equal(s.statusline.dir, "/repo/b");
  assert.equal(s.statusline.branch, "dev");
  assert.equal(s.statusline.dirty, true);
  assert.equal(s.statusline.model, "haiku");
  assert.equal(s.specCount, 3);
  assert.equal(s.deferCount, 1);
});

test("TAB_SWITCHED: 이전 탭의 streaming·approval·gateStatus·streamingText를 절대 이어받지 않는다(교차오염 차단)", () => {
  let s = createInitialState();
  s = reduce(s, { type: "TURN_START" });
  s = reduce(s, { type: "APPROVAL_REQUESTED", reason: "r" });
  s = reduce(s, { type: "STREAM_DELTA", text: "이전 탭 진행중 텍스트" });
  s = reduce(s, { type: "GATE_RESULT", status: "block", specCount: 9, deferCount: 9 });
  s = reduce(s, { type: "TAB_SWITCHED", dir: "/repo/b", branch: "", dirty: false, model: "", specCount: 0, deferCount: 0 });
  assert.equal(s.streaming, false);
  assert.equal(s.approval, null);
  assert.equal(s.streamingText, "");
  assert.equal(s.gateStatus, "idle");
});

test("TAB_SWITCHED: splashShown은 true로 유지(전환마다 스플래시 재노출 방지)", () => {
  let s = createInitialState();
  s = reduce(s, { type: "SESSION_START" });
  s = reduce(s, { type: "TAB_SWITCHED", dir: "/repo/b", branch: "", dirty: false, model: "", specCount: 0, deferCount: 0 });
  assert.equal(s.splashShown, true);
});

test("TURN_START: streamingText도 함께 리셋(직전 턴의 잔여 델타가 다음 턴에 안 섞이도록 방어)", () => {
  let s = createInitialState();
  s = reduce(s, { type: "STREAM_DELTA", text: "이전 턴 잔여" });
  s = reduce(s, { type: "TURN_START" });
  assert.equal(s.streamingText, "");
  assert.equal(s.streaming, true, "기존 계약 유지");
});
