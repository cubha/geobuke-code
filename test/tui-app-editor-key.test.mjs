// SubTask1(refactoring) — app.tsx applyEditorKey RED: key.delete가 backspace로 오처리되던 버그.
// deleteForward(커서 뒤 문자 삭제)와 backspace(커서 앞 문자 삭제)는 결과가 다르므로 이 차이로 검증한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEditorKey } from "../dist/tui/app.js";

function stateAt(line, cursorCol) {
  return { lines: [line], cursorRow: 0, cursorCol, history: [], historyIndex: null, historyDraft: "" };
}

test("applyEditorKey: key.delete는 커서 뒤 문자를 지운다(deleteForward, 커서 불변)", () => {
  const s = stateAt("abc", 1); // 커서는 'b' 앞
  const next = applyEditorKey("", { delete: true }, s);
  assert.equal(next.lines[0], "ac"); // 'b' 제거
  assert.equal(next.cursorCol, 1); // 커서 위치 불변
});

test("applyEditorKey: key.backspace는 커서 앞 문자를 지운다(backspace, 커서 좌이동)", () => {
  const s = stateAt("abc", 1); // 커서는 'b' 앞
  const next = applyEditorKey("", { backspace: true }, s);
  assert.equal(next.lines[0], "bc"); // 'a' 제거
  assert.equal(next.cursorCol, 0); // 커서가 왼쪽으로 이동
});
