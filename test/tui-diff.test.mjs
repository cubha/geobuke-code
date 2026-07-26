// 0.11.0 ST2-1 — src/tui/diff.ts 순수부 단정. 도구 승인 프롬프트에 Edit/Write/MultiEdit/Bash의
// 실제 변경내용을 보여주기 위한 포맷터(지금까지는 decisionReason 문구만 보여 사용자가 무엇을
// 승인하는지 알 수 없었다 — bridge.ts classifyApprovalRequest는 spec-add만 특별취급했다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToolPreview } from "../dist/tui/diff.js";

function texts(segLines) {
  return segLines.map((line) => line.map((s) => s.text).join(""));
}

test("formatToolPreview: Edit — file_path + old_string(−)·new_string(+) 라인", () => {
  const out = formatToolPreview(
    "Edit",
    { file_path: "src/a.ts", old_string: "foo", new_string: "bar" },
    10,
  );
  const t = texts(out);
  assert.equal(t[0], "src/a.ts");
  assert.equal(t[1], "− foo");
  assert.equal(t[2], "+ bar");
});

test("formatToolPreview: Edit — old_string/new_string 톤이 danger/accent", () => {
  const out = formatToolPreview("Edit", { file_path: "x", old_string: "a", new_string: "b" }, 10);
  assert.equal(out[1][0].tone, "danger");
  assert.equal(out[2][0].tone, "accent");
});

test("formatToolPreview: Write — file_path + content head", () => {
  const out = formatToolPreview("Write", { file_path: "new.txt", content: "line1\nline2\nline3" }, 10);
  const t = texts(out);
  assert.deepEqual(t, ["new.txt", "line1", "line2", "line3"]);
});

test("formatToolPreview: MultiEdit — 'file_path — N건 편집' 요약 1줄", () => {
  const out = formatToolPreview(
    "MultiEdit",
    { file_path: "b.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] },
    10,
  );
  assert.equal(texts(out).length, 1);
  assert.match(texts(out)[0], /b\.ts — 2건 편집/);
});

test("formatToolPreview: Bash — command을 줄 단위 그대로", () => {
  const out = formatToolPreview("Bash", { command: "echo hi\necho bye" }, 10);
  assert.deepEqual(texts(out), ["echo hi", "echo bye"]);
});

test("formatToolPreview: rowBudget 초과 시 head에서 잘리고 '…N행 생략' 마커가 붙는다", () => {
  const out = formatToolPreview("Bash", { command: "1\n2\n3\n4\n5" }, 3);
  assert.equal(out.length, 3);
  assert.deepEqual(texts(out.slice(0, 2)), ["1", "2"]);
  assert.match(texts(out)[2], /…3행 생략/);
});

test("formatToolPreview: rowBudget<=0 — 빈 배열(예산 없음)", () => {
  assert.deepEqual(formatToolPreview("Bash", { command: "x" }, 0), []);
});

test("formatToolPreview: 알 수 없는 도구명 — 빈 배열(app.tsx가 기존 reason 표시로 폴백)", () => {
  assert.deepEqual(formatToolPreview("SomeUnknownTool", { x: 1 }, 10), []);
});

test("formatToolPreview: Edit에서 file_path/old_string/new_string 누락 시 크래시 없이 빈 문자열로 취급", () => {
  assert.doesNotThrow(() => formatToolPreview("Edit", {}, 10));
});
