// engine mapSdkMessage 단정 (0.7.0 A1 ST3). SDK 메시지→extraction 레코드 순수 매핑.
// runEngine(SDK I/O)은 ST7 E2E 수동 실측 — 여기선 매퍼만(순수 분리).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSdkMessage } from "../dist/engine.js";

test("assistant tool_use 블록 → tool_use 레코드(tool·file·session)", () => {
  const recs = mapSdkMessage({
    type: "assistant",
    session_id: "sess-A",
    message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/x.ts", old_string: "a", new_string: "b" } }] },
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, "tool_use");
  assert.equal(recs[0].tool, "Edit");
  assert.equal(recs[0].file, "src/x.ts");
  assert.equal(recs[0].session, "sess-A", "session_id가 조인키로 전파");
});

test("assistant text 블록 → assistant 레코드(text)", () => {
  const recs = mapSdkMessage({
    type: "assistant",
    session_id: "sess-A",
    message: { content: [{ type: "text", text: "구현을 시작합니다" }] },
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, "assistant");
  assert.match(recs[0].text, /구현을 시작/);
});

test("assistant 다중 블록(text+tool_use) → 블록당 레코드", () => {
  const recs = mapSdkMessage({
    type: "assistant",
    session_id: "s1",
    message: { content: [
      { type: "text", text: "먼저 파일을 수정" },
      { type: "tool_use", name: "Write", input: { file_path: "a.ts" } },
    ] },
  });
  assert.equal(recs.length, 2);
  assert.equal(recs[0].kind, "assistant");
  assert.equal(recs[1].kind, "tool_use");
  assert.equal(recs[1].tool, "Write");
});

test("result 메시지 → result 레코드(과금·턴 요약)", () => {
  const recs = mapSdkMessage({
    type: "result",
    subtype: "success",
    session_id: "s1",
    total_cost_usd: 0.0123,
    num_turns: 3,
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, "result");
  assert.match(recs[0].text, /0\.0123|success|3/, "과금·턴 요약 포함");
});

test("user tool_result 블록 → tool_result 레코드", () => {
  const recs = mapSdkMessage({
    type: "user",
    session_id: "s1",
    message: { content: [{ type: "tool_result", content: "파일 수정됨" }] },
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, "tool_result");
});

test("노이즈 메시지(system/status/partial) → 빈 배열", () => {
  assert.deepEqual(mapSdkMessage({ type: "system", subtype: "init", session_id: "s1" }), []);
  assert.deepEqual(mapSdkMessage({ type: "stream_event", session_id: "s1" }), []);
});

test("session_id 없는 메시지 → 빈 배열(조인 불가 skip)", () => {
  assert.deepEqual(
    mapSdkMessage({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }),
    [],
    "session 없으면 관측 불가로 skip",
  );
});
