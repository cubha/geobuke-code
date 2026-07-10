// 0.9.0 A3a ST2 — src/tui/editor.ts 멀티라인 입력 에디터 순수 텍스트버퍼 단정.
// Ink 미제공 영역(ink#676) 자체구현분. 키맵: Enter=제출, Shift+Enter=개행,
// ↑↓=빈 입력창에서 히스토리 진입, 진입 후엔 계속 탐색(좌우/편집으로 이탈)·
// 애초에 내용 있으면 커서 이동.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState,
  insertText,
  newline,
  backspace,
  deleteForward,
  moveCursorLeft,
  moveCursorRight,
  moveCursorUp,
  moveCursorDown,
  arrowUp,
  arrowDown,
  isEmpty,
  getText,
  commitSubmit,
} from "../dist/tui/editor.js";

test("createInitialState: lines=[''], 커서 (0,0), history 빈배열", () => {
  const s = createInitialState();
  assert.deepEqual(s.lines, [""]);
  assert.equal(s.cursorRow, 0);
  assert.equal(s.cursorCol, 0);
  assert.deepEqual(s.history, []);
  assert.equal(s.historyIndex, null);
});

test("insertText: 빈 버퍼에 'abc' 삽입 — 커서가 끝으로 이동", () => {
  const s = insertText(createInitialState(), "abc");
  assert.deepEqual(s.lines, ["abc"]);
  assert.equal(s.cursorRow, 0);
  assert.equal(s.cursorCol, 3);
});

test("insertText: 커서 위치(중간)에 삽입 — 기존 텍스트 스플라이스", () => {
  let s = insertText(createInitialState(), "ac");
  s = { ...s, cursorCol: 1 }; // "a|c"
  s = insertText(s, "b");
  assert.deepEqual(s.lines, ["abc"]);
  assert.equal(s.cursorCol, 2);
});

test("insertText: 개행 포함 문자열(paste) — 여러 줄로 분할, 커서는 삽입 끝", () => {
  const s = insertText(createInitialState(), "line1\nline2");
  assert.deepEqual(s.lines, ["line1", "line2"]);
  assert.equal(s.cursorRow, 1);
  assert.equal(s.cursorCol, 5);
});

test("insertText: paste가 기존 줄 중간을 가르며 삽입(꼬리 보존)", () => {
  let s = insertText(createInitialState(), "AZ");
  s = { ...s, cursorCol: 1 }; // "A|Z"
  s = insertText(s, "X\nY");
  assert.deepEqual(s.lines, ["AX", "YZ"], "삽입 앞부분은 첫줄에 붙고 뒷부분은 마지막 삽입줄+원래 꼬리");
  assert.equal(s.cursorRow, 1);
  assert.equal(s.cursorCol, 1);
});

test("newline: Shift+Enter — 커서 위치에서 줄 분할, 다음줄 (row+1,0)로 이동", () => {
  let s = insertText(createInitialState(), "abcd");
  s = { ...s, cursorCol: 2 }; // "ab|cd"
  s = newline(s);
  assert.deepEqual(s.lines, ["ab", "cd"]);
  assert.equal(s.cursorRow, 1);
  assert.equal(s.cursorCol, 0);
});

test("backspace: 커서 앞 문자 삭제", () => {
  let s = insertText(createInitialState(), "abc");
  s = backspace(s);
  assert.deepEqual(s.lines, ["ab"]);
  assert.equal(s.cursorCol, 2);
});

test("backspace: 줄 맨앞(col0,row>0) — 이전 줄과 병합, 커서는 병합 경계", () => {
  let s = insertText(createInitialState(), "ab\ncd");
  assert.equal(s.cursorRow, 1);
  s = { ...s, cursorCol: 0 };
  s = backspace(s);
  assert.deepEqual(s.lines, ["abcd"]);
  assert.equal(s.cursorRow, 0);
  assert.equal(s.cursorCol, 2);
});

test("backspace: 문서 맨앞(0,0) — no-op", () => {
  const s0 = createInitialState();
  const s1 = backspace(s0);
  assert.deepEqual(s1, s0);
});

test("deleteForward: 커서 위치 문자 삭제(커서 불변)", () => {
  let s = insertText(createInitialState(), "abc");
  s = { ...s, cursorCol: 1 }; // "a|bc"
  s = deleteForward(s);
  assert.deepEqual(s.lines, ["ac"]);
  assert.equal(s.cursorCol, 1);
});

test("deleteForward: 줄 끝(다음 줄 존재) — 다음 줄을 끌어올려 병합", () => {
  let s = insertText(createInitialState(), "ab\ncd");
  s = { ...s, cursorRow: 0, cursorCol: 2 }; // "ab|" (row0 끝)
  s = deleteForward(s);
  assert.deepEqual(s.lines, ["abcd"]);
  assert.equal(s.cursorRow, 0);
  assert.equal(s.cursorCol, 2);
});

test("deleteForward: 문서 맨끝 — no-op", () => {
  const s0 = insertText(createInitialState(), "abc");
  const s1 = deleteForward(s0);
  assert.deepEqual(s1, s0);
});

test("moveCursorLeft/Right: 줄 경계를 넘어 이동", () => {
  let s = insertText(createInitialState(), "ab\ncd");
  s = { ...s, cursorRow: 1, cursorCol: 0 };
  s = moveCursorLeft(s);
  assert.deepEqual([s.cursorRow, s.cursorCol], [0, 2], "이전 줄 끝으로 이동");
  s = moveCursorRight(s);
  assert.deepEqual([s.cursorRow, s.cursorCol], [1, 0], "다음 줄 시작으로 이동");
});

test("moveCursorLeft: 문서 맨앞에서 no-op / moveCursorRight: 문서 맨끝에서 no-op", () => {
  const s0 = createInitialState();
  assert.deepEqual(moveCursorLeft(s0), s0);
  const s1 = insertText(createInitialState(), "ab");
  assert.deepEqual(moveCursorRight(s1), s1);
});

test("moveCursorUp/Down: 컬럼 유지 시도, 짧은 줄이면 클램프", () => {
  let s = insertText(createInitialState(), "abcdef\nxy");
  // 현재 커서: row1 col2(줄 "xy" 끝)
  s = moveCursorUp(s);
  assert.equal(s.cursorRow, 0);
  assert.equal(s.cursorCol, 2, "짧은 줄에서 올라와도 원래 col 유지(6자 줄이라 자를 필요 없음)");
  s = { ...s, cursorCol: 6 }; // row0 끝
  s = moveCursorDown(s);
  assert.equal(s.cursorRow, 1);
  assert.equal(s.cursorCol, 2, "짧은 줄(xy, 길이2)로 내려가면 클램프");
});

test("isEmpty: 초기상태만 true, 텍스트/개행 있으면 false", () => {
  assert.equal(isEmpty(createInitialState()), true);
  assert.equal(isEmpty(insertText(createInitialState(), "a")), false);
  assert.equal(isEmpty(newline(createInitialState())), false, "빈 줄이 2개여도 비어있지 않음(개행 자체가 내용)");
});

test("arrowUp/Down: 버퍼가 비었으면 히스토리 탐색, 내용 있으면 커서 이동", () => {
  let s = createInitialState();
  s = commitSubmit(insertText(s, "first")).state;
  s = commitSubmit(insertText(s, "second")).state;
  assert.deepEqual(s.history, ["first", "second"]);
  // 빈 버퍼에서 ↑ → 히스토리
  s = arrowUp(s);
  assert.equal(getText(s), "second", "가장 최근 히스토리부터");
  s = arrowUp(s);
  assert.equal(getText(s), "first");
  s = arrowUp(s);
  assert.equal(getText(s), "first", "맨 앞에서 더 위로 가면 정지(래핑 없음)");
  s = arrowDown(s);
  assert.equal(getText(s), "second");
  s = arrowDown(s);
  assert.equal(getText(s), "", "히스토리 맨 뒤를 지나면 원래 draft(빈 문자열)로 복귀");
});

test("arrowUp: 버퍼에 내용이 있으면 히스토리 대신 커서만 이동(줄 이동)", () => {
  let s = createInitialState();
  s = commitSubmit(insertText(s, "past")).state;
  s = insertText(s, "line1\nline2");
  const before = s;
  s = arrowUp(s);
  assert.equal(s.history.length, 1, "히스토리 미소비");
  assert.equal(s.cursorRow, 0, "moveCursorUp과 동일 동작");
  assert.notDeepEqual(s, before);
});

test("commitSubmit: 비어있지 않은 텍스트 — history에 push, 버퍼 초기화", () => {
  const s0 = insertText(createInitialState(), "hello");
  const { text, state } = commitSubmit(s0);
  assert.equal(text, "hello");
  assert.deepEqual(state.lines, [""]);
  assert.equal(state.cursorRow, 0);
  assert.equal(state.cursorCol, 0);
  assert.deepEqual(state.history, ["hello"]);
  assert.equal(state.historyIndex, null);
});

test("commitSubmit: 공백만 있는 텍스트 — no-op(text=null, 상태 불변)", () => {
  const s0 = insertText(createInitialState(), "   ");
  const { text, state } = commitSubmit(s0);
  assert.equal(text, null);
  assert.deepEqual(state, s0);
});

test("commitSubmit: 연속 중복 제출은 history에 다시 쌓지 않음", () => {
  let s = createInitialState();
  s = commitSubmit(insertText(s, "same")).state;
  s = commitSubmit(insertText(s, "same")).state;
  assert.deepEqual(s.history, ["same"]);
});

test("모든 편집 연산은 입력 state를 변형하지 않는다(순수성)", () => {
  const s0 = insertText(createInitialState(), "ab\ncd");
  const frozen = JSON.stringify(s0);
  insertText(s0, "x");
  backspace(s0);
  newline(s0);
  moveCursorUp(s0);
  assert.equal(JSON.stringify(s0), frozen);
});
