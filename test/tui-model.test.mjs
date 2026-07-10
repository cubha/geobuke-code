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
