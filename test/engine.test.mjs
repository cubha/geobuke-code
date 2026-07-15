// engine mapSdkMessage 단정 (0.7.0 A1 ST3). SDK 메시지→extraction 레코드 순수 매핑.
// runEngine(SDK I/O)은 ST7 E2E 수동 실측 — 여기선 매퍼만(순수 분리).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapSdkMessage, buildEngineOptions, PushableStream, buildEngineResultFromResult, makeUserMessage, withWatchdog, buildSessionEndedResult } from "../dist/engine.js";

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

// ===== buildEngineOptions 불변식 회귀락 (ST6) — anti-recursion + ⓑ 자격증명 미주입 =====

test("buildEngineOptions: settingSources는 항상 [](anti-recursion 불변식 — gbc hook 이중발화·재귀 차단)", () => {
  assert.deepEqual(buildEngineOptions({ prompt: "x", cwd: "/tmp/a" }).settingSources, []);
  // 콜백·모델이 있어도 불변
  assert.deepEqual(
    buildEngineOptions({ prompt: "x", cwd: "/tmp/a", model: "haiku", preToolUse: async () => ({}), canUseTool: async () => ({ behavior: "allow" }) }).settingSources,
    [],
  );
});

test("buildEngineOptions: apiKey를 절대 주입하지 않는다(ⓑ 인증·과금 실측 보존)", () => {
  const o = buildEngineOptions({ prompt: "x", cwd: "/tmp/a" });
  assert.ok(!("apiKey" in o), "apiKey 키 부재 — SDK 자체 인증 우선순위 관측");
});

test("buildEngineOptions: preToolUse/canUseTool/model이 있으면 배선, 없으면 미포함", () => {
  const bare = buildEngineOptions({ prompt: "x", cwd: "/tmp/a" });
  assert.ok(!("hooks" in bare) && !("canUseTool" in bare) && !("model" in bare), "미지정은 옵션에 미포함");
  const wired = buildEngineOptions({ prompt: "x", cwd: "/tmp/a", model: "haiku", preToolUse: async () => ({}), canUseTool: async () => ({ behavior: "allow" }) });
  assert.equal(wired.model, "haiku");
  assert.ok(Array.isArray(wired.hooks.PreToolUse), "PreToolUse 콜백 배선");
  assert.equal(typeof wired.canUseTool, "function");
});

test("buildEngineOptions: onMessage(0.9.0 A3a TUI 관측 seam)은 SDK query() 옵션에 새지 않는다", () => {
  const o = buildEngineOptions({ prompt: "x", cwd: "/tmp/a", onMessage: () => {} });
  assert.ok(!("onMessage" in o), "onMessage는 runEngine 루프 내부 콜백일 뿐 Options 필드가 아님");
});

// ===== abortController seam (0.9.2 ST1 — Esc 중단) =====

test("buildEngineOptions: abortController가 있으면 그대로 배선, 없으면 미포함", () => {
  const bare = buildEngineOptions({ prompt: "x", cwd: "/tmp/a" });
  assert.ok(!("abortController" in bare), "미지정은 옵션에 미포함");
  const ac = new AbortController();
  const wired = buildEngineOptions({ prompt: "x", cwd: "/tmp/a", abortController: ac });
  assert.equal(wired.abortController, ac, "동일 인스턴스를 그대로 전달(복제 없음)");
});

// ===== claudeExecutablePath seam (0.9.2 ST4 — 회사 보안정책의 번들 claude.exe EPERM 차단 우회) =====

test("buildEngineOptions: claudeExecutablePath가 있으면 SDK pathToClaudeCodeExecutable로 배선, 없으면 미포함", () => {
  const bare = buildEngineOptions({ prompt: "x", cwd: "/tmp/a" });
  assert.ok(!("pathToClaudeCodeExecutable" in bare), "미지정은 옵션에 미포함(SDK 기본 번들 exe 사용)");
  const wired = buildEngineOptions({ prompt: "x", cwd: "/tmp/a", claudeExecutablePath: "C:\\allow\\claude.exe" });
  assert.equal(wired.pathToClaudeCodeExecutable, "C:\\allow\\claude.exe");
});

// ===== PushableStream (0.9.4 ST1 — createEngineSession의 outgoing prompt AsyncIterable) =====
// SDK 스트리밍 입력 모드의 prompt: AsyncIterable<SDKUserMessage>를 매 submit()마다 하나씩 밀어넣는
// pushable 큐. push가 소비보다 먼저 오든 나중에 오든 순서를 보존해야 하고(다음 for-await가 그 값을
// 받아야), close() 후에는 대기 중이던 소비자도 정상 종료(done:true)돼야 한다(ST0 스파이크가 관찰한
// "input generator가 안 끝나도 interrupt로 output 루프는 끝난다"와는 별개로, close()의 명시적 종료
// 경로 자체는 결정론적으로 보장돼야 함).

test("PushableStream: push 먼저 → 이후 next()가 즉시 그 값을 받는다(순서 보존)", async () => {
  const s = new PushableStream();
  s.push({ v: 1 });
  s.push({ v: 2 });
  const it = s[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: { v: 1 }, done: false });
  assert.deepEqual(await it.next(), { value: { v: 2 }, done: false });
});

test("PushableStream: next() 먼저 대기 → 이후 push()가 그 대기를 resolve한다", async () => {
  const s = new PushableStream();
  const it = s[Symbol.asyncIterator]();
  const pending = it.next();
  s.push({ v: "late" });
  assert.deepEqual(await pending, { value: { v: "late" }, done: false });
});

test("PushableStream: close() 이후 next()는 done:true(대기 중이던 소비자도 즉시 해제)", async () => {
  const s = new PushableStream();
  const it = s[Symbol.asyncIterator]();
  const pending = it.next(); // close() 전에 대기 시작
  s.close();
  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.deepEqual(await it.next(), { value: undefined, done: true }, "close 후 신규 next()도 done");
});

test("PushableStream: close() 후 push()는 무시된다(재개하지 않음)", async () => {
  const s = new PushableStream();
  s.close();
  s.push({ v: "too-late" });
  const it = s[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

// ===== buildEngineResultFromResult (0.9.4 ST1) =====
// ST0 스파이크 실측: query.interrupt()는 throw하지 않고 result{subtype:"error_during_execution",
// is_error:true}를 정상 yield한다 — 기존 catch 블록(abortController 경로)과는 다른 신호 채널이라
// 별도 순수 매핑이 필요하다. wasInterrupted는 EngineSession이 "직전에 우리가 interrupt()를 호출했다"를
// 추적하는 로컬 플래그를 그대로 전달한다(이 함수는 그 판단을 하지 않고 결과만 재해석).

test("buildEngineResultFromResult: 정상 success result → isError false, aborted 없음", () => {
  const r = buildEngineResultFromResult(
    { subtype: "success", total_cost_usd: 0.01, num_turns: 1, session_id: "s1" },
    false,
  );
  assert.equal(r.isError, false);
  assert.equal(r.aborted, undefined);
  assert.equal(r.costUsd, 0.01);
  assert.equal(r.sessionId, "s1");
});

test("buildEngineResultFromResult: wasInterrupted=false인 error_during_execution → 진짜 오류(isError true)", () => {
  const r = buildEngineResultFromResult(
    { subtype: "error_during_execution", is_error: true, total_cost_usd: 0.02, session_id: "s1" },
    false,
  );
  assert.equal(r.isError, true, "interrupt를 요청하지 않았으면 이 result는 실제 실패로 취급");
  assert.equal(r.aborted, undefined);
});

test("buildEngineResultFromResult: wasInterrupted=true인 error_during_execution → aborted(isError false로 재해석)", () => {
  const r = buildEngineResultFromResult(
    { subtype: "error_during_execution", is_error: true, total_cost_usd: 0.02, session_id: "s1" },
    true,
  );
  assert.equal(r.aborted, true, "직전 interrupt() 호출로 인한 result는 사용자 의도 취소");
  assert.equal(r.isError, false, "aborted/isError 배타(EngineResult 계약)");
});

test("buildEngineResultFromResult: wasInterrupted=true인데 success result면 그냥 success(aborted 오염 없음)", () => {
  // 레이스: interrupt() 호출 직후 이미 진행 중이던 턴이 정상 완료될 수 있다(interrupt는 non-blocking).
  const r = buildEngineResultFromResult(
    { subtype: "success", total_cost_usd: 0.01, session_id: "s1" },
    true,
  );
  assert.equal(r.isError, false);
  assert.equal(r.aborted, undefined, "정상 성공은 aborted로 오염되지 않는다");
});

// ===== makeUserMessage (0.9.4 ST1) =====

test("makeUserMessage: SDKUserMessage 최소 형상(role=user·content=prompt·session_id 빈값)", () => {
  const m = makeUserMessage("안녕");
  assert.equal(m.type, "user");
  assert.equal(m.message.role, "user");
  assert.equal(m.message.content, "안녕");
  assert.equal(m.parent_tool_use_id, null);
});

// ===== withWatchdog (0.9.4 ST2) =====
// braintrust 실측 근거: SDK ProcessTransport.write()는 죽은 stdin에 침묵 드랍(예외 없음) — 세션이
// 죽어도 submit()의 대기 Promise가 영원히 안 풀릴 수 있다. 워치독은 그 무한대기를 유한 시간으로
// 끊는 범용 유틸(정상 응답 경로는 건드리지 않는다 — 레이스에서 원래 promise가 이기면 그대로 통과).

test("withWatchdog: 원래 promise가 타임아웃 전에 resolve하면 그 값을 그대로 반환(워치독 개입 없음)", async () => {
  const fast = Promise.resolve("정상응답");
  const r = await withWatchdog(fast, 50, () => "타임아웃값");
  assert.equal(r, "정상응답");
});

test("withWatchdog: 원래 promise가 타임아웃 내 resolve 안 하면 onTimeout() 값을 대신 반환", async () => {
  const neverResolves = new Promise(() => {});
  const r = await withWatchdog(neverResolves, 20, () => "타임아웃값");
  assert.equal(r, "타임아웃값");
});

test("withWatchdog: 타임아웃 후 원래 promise가 뒤늦게 resolve해도 이미 반환된 결과에 영향 없음", async () => {
  let resolveLate;
  const late = new Promise((r) => (resolveLate = r));
  const r = await withWatchdog(late, 20, () => "타임아웃값");
  assert.equal(r, "타임아웃값");
  resolveLate("뒤늦은응답"); // 워치독 이후 resolve — throw 없이 조용히 무시돼야 함
  await new Promise((r) => setTimeout(r, 10));
});

// ===== includePartialMessages seam (0.9.4 ST3 — T2 stream_event 수신을 위한 SDK 옵션) =====
// 스모크 실측으로 발견: DeltaAssembler를 만들어도 SDK의 includePartialMessages를 켜지 않으면
// stream_event 자체가 오지 않는다(관측 0건) — 어셈블러 존재만으로는 T2가 완결되지 않는다.

test("buildEngineOptions: includePartialMessages가 true면 그대로 배선, 없으면/false면 미포함", () => {
  const bare = buildEngineOptions({ prompt: "x", cwd: "/tmp/a" });
  assert.ok(!("includePartialMessages" in bare), "미지정은 옵션에 미포함(headless gbc run은 불필요)");
  const off = buildEngineOptions({ prompt: "x", cwd: "/tmp/a", includePartialMessages: false });
  assert.ok(!("includePartialMessages" in off), "false도 미포함(굳이 SDK에 false를 실어보내지 않음)");
  const on = buildEngineOptions({ prompt: "x", cwd: "/tmp/a", includePartialMessages: true });
  assert.equal(on.includePartialMessages, true);
});

// ===== buildSessionEndedResult (0.9.4 ST2) =====

test("buildSessionEndedResult: isError true + error에 사유 포함 + records 0", () => {
  const r = buildSessionEndedResult("sess-1", null, "watchdog timeout");
  assert.equal(r.sessionId, "sess-1");
  assert.equal(r.isError, true);
  assert.match(r.error, /watchdog timeout/);
  assert.equal(r.records, 0);
  assert.equal(r.aborted, undefined, "세션 죽음은 사용자 의도 취소(aborted)와 다른 채널");
});

// ===== createEngineSession 세션경로 불변식 회귀락 (0.9.4 ST6) =====
// buildEngineOptions 자체의 불변식(settingSources:[]·apiKey 미주입)은 위에서 이미 단위테스트로
// 고정돼 있다 — 이 테스트가 잠그는 건 별개: "createEngineSession도 반드시 그 함수를 경유한다"는
// *경로* 불변식이다. createEngineSession은 실 SDK I/O(dynamic import+spawn)라 runEngine과 동일한
// 이유로 직접 단위테스트 대상이 아니므로(비결정 I/O), 소스 레벨로 "buildEngineOptions(...) 호출을
// 우회해 Options를 직접 구성하지 않는다"를 고정한다 — 세션 경로 신설(ST1)이 이 강제 지점을 우회해
// settingSources 누락(anti-recursion 무력화)이나 apiKey 하드코딩(ⓑ 실측 오염)을 재도입하면 이 테스트가
// 즉시 깨진다.
test("createEngineSession: buildEngineOptions를 경유한다(불변식 강제 지점 우회 방지)", () => {
  const src = readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
  const fnStart = src.indexOf("export async function createEngineSession(");
  assert.ok(fnStart >= 0, "createEngineSession 함수를 dist에서 찾을 수 없음 — 시그니처/이름이 바뀌었으면 이 테스트도 함께 갱신할 것");
  const fnHead = src.slice(fnStart, fnStart + 400); // 함수 도입부(옵션 빌드 지점)만 보면 충분
  assert.match(fnHead, /buildEngineOptions\(/, "createEngineSession은 반드시 buildEngineOptions를 경유해 Options를 구성해야 한다");
});
