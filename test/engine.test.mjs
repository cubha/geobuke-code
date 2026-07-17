// engine mapSdkMessage 단정 (0.7.0 A1 ST3). SDK 메시지→extraction 레코드 순수 매핑.
// runEngine(SDK I/O)은 ST7 E2E 수동 실측 — 여기선 매퍼만(순수 분리).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mapSdkMessage,
  buildEngineOptions,
  PushableStream,
  buildEngineResultFromResult,
  makeUserMessage,
  withWatchdog,
  buildSessionEndedResult,
  buildSessionOptionsForRepo,
  isResumeFailure,
  shouldNotifyEnded,
  createPausableWatchdog,
} from "../dist/engine.js";

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

// 0.10.0 A3b 실기검증 이슈①(braintrust 4렌즈 만장일치+headless `claude -p` 실측 확정, 2026-07-16):
// settingSources:[]는 auto-memory(~/.claude/projects/<repo>/memory/)를 제어하지 않는다(SDK 공식
// 문서 명시) — spawn된 A-mode 세션이 도구 호출 없이 판정대상 repo의 memory/MEMORY.md 내용을
// 알고 응답했다(트랜스크립트 67c09495 실측). settings:{autoMemoryEnabled:false}가 SDK 공식
// 격리 패턴이며, 실측(`claude -p --settings '{"autoMemoryEnabled":false}'`)으로 차단 효과를
// 직접 확인했다(baseline="0.10.0 완료됐다"+메모리 근거 명시 vs 차단 시 git diff 기반 정확한
// 미완 판단으로 반전).
test("buildEngineOptions: settings는 항상 {autoMemoryEnabled:false}(auto-memory 격리 불변식 — settingSources:[]가 커버 못 하는 별도 레이어)", () => {
  assert.deepEqual(buildEngineOptions({ prompt: "x", cwd: "/tmp/a" }).settings, { autoMemoryEnabled: false });
  assert.deepEqual(
    buildEngineOptions({ prompt: "x", cwd: "/tmp/a", model: "haiku", resume: "sess-1" }).settings,
    { autoMemoryEnabled: false },
    "resume 등 다른 옵션이 있어도 불변",
  );
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
  // 0.10.0 ST6이 buildEngineOptions 호출 전에 canUseTool 워치독 래핑 로직을 추가해 함수 도입부가
  // 늘어났다(정당한 갱신 — 검색 창을 넓힐 뿐 이 테스트가 지키는 불변식 자체는 그대로): 1200자로 확장.
  const fnHead = src.slice(fnStart, fnStart + 1200);
  assert.match(fnHead, /buildEngineOptions\(/, "createEngineSession은 반드시 buildEngineOptions를 경유해 Options를 구성해야 한다");
});

// ===== 0.10.0 A3b ST2 — repoId 원자 결박 + resume 그레이스풀 폴백 =====

test("buildEngineOptions: resume이 있으면 SDK Options.resume으로 배선, 없으면 미포함", () => {
  const bare = buildEngineOptions({ prompt: "x", cwd: "/tmp/a" });
  assert.equal("resume" in bare, false);
  const wired = buildEngineOptions({ prompt: "x", cwd: "/tmp/a", resume: "sess-prev" });
  assert.equal(wired.resume, "sess-prev");
});

// buildSessionOptionsForRepo — "탭이 여러 개일 때 세션 옵션의 cwd가 그 탭의 repoId와 물리적으로
// 어긋날 수 없다"는 회귀락(ST2). base에 다른 cwd가 실려 있어도(예: 여러 탭이 같은 base 객체를
// 재사용하다 뒤섞인 경우) repoId가 항상 이긴다 — "세션 팩토리 원자 결박"의 핵심.
test("buildSessionOptionsForRepo: cwd는 항상 repoId — base.cwd가 달라도 repoId로 강제 덮어씀", () => {
  const opts = buildSessionOptionsForRepo("/repo/target", { cwd: "/repo/WRONG", model: "haiku" });
  assert.equal(opts.cwd, "/repo/target");
  assert.equal(opts.model, "haiku", "무관 필드는 보존");
});

test("buildSessionOptionsForRepo: base에 cwd가 없어도 repoId가 채워진다", () => {
  const opts = buildSessionOptionsForRepo("/repo/target", { watchdogMs: 1000 });
  assert.equal(opts.cwd, "/repo/target");
  assert.equal(opts.watchdogMs, 1000);
});

// isResumeFailure — resume 시도의 첫 submit이 SESSION_ENDED로 즉시 실패했는지 판정하는 순수 술어.
// createEngineSessionWithResumeFallback(비결정 I/O 오케스트레이션, createEngineSession과 동일 이유로
// 직접 단위테스트 대상 아님)이 이 술어로 "resume 없이 fresh 세션 재시도"를 결정한다.
test("isResumeFailure: SESSION_ENDED 에러면 true(resume 실패로 간주)", () => {
  const r = buildSessionEndedResult("", null, "watchdog timeout");
  assert.equal(isResumeFailure(r), true);
});

test("isResumeFailure: 일반 에러(SESSION_ENDED 아님)는 false — resume과 무관한 실패라 폴백 대상 아님", () => {
  assert.equal(isResumeFailure({ sessionId: "", costUsd: 0, numTurns: 0, auth: null, records: 0, isError: true, error: "network timeout" }), false);
});

test("isResumeFailure: 성공(isError:false)이면 false", () => {
  assert.equal(isResumeFailure({ sessionId: "s", costUsd: 0.01, numTurns: 1, auth: null, records: 1, isError: false }), false);
});

// ===== 0.10.0 A3b ST5 — onEnded 발화 조건(shouldNotifyEnded) =====

test("shouldNotifyEnded: 유휴 상태(대기 submit 없음)+의도치 않은 종료 → true(유일한 통지 채널)", () => {
  assert.equal(shouldNotifyEnded(false, false), true);
});

test("shouldNotifyEnded: 대기 중인 submit()이 있었으면 false(그 submit의 반환값이 이미 통지)", () => {
  assert.equal(shouldNotifyEnded(true, false), false);
});

test("shouldNotifyEnded: close()로 의도된 종료면 false(사용자 opt-out을 죽음으로 오보하지 않음)", () => {
  assert.equal(shouldNotifyEnded(false, true), false);
});

test("shouldNotifyEnded: 대기 중이었고 의도된 종료도 겹치면 false", () => {
  assert.equal(shouldNotifyEnded(true, true), false);
});

test("createEngineSessionWithResumeFallback: createEngineSession을 경유한다(중복 query() 배선 방지 회귀락)", () => {
  const src = readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
  const fnStart = src.indexOf("export async function createEngineSessionWithResumeFallback(");
  assert.ok(fnStart >= 0, "createEngineSessionWithResumeFallback 함수를 dist에서 찾을 수 없음");
  const fnBody = src.slice(fnStart, fnStart + 1500);
  assert.match(fnBody, /createEngineSession\(/, "직접 query()를 새로 배선하지 않고 createEngineSession을 경유해야 buildEngineOptions 불변식이 유지된다");
});

// ===== 0.10.0 A3b ST6 — createPausableWatchdog (승인 대기 중 워치독 일시정지) =====
// 배경: canUseTool 승인 대기는 사람이 응답할 때까지(수 초~수 분) 걸릴 수 있는 정상 상태다. 기존
// withWatchdog은 이 대기 시간도 그대로 카운트해, 백그라운드 탭이 정상적으로 승인을 기다리는 중인데
// 워치독이 "응답 없음(세션 사망)"으로 오판해 진짜 죽여버릴 수 있었다 — pause()/resume()으로 승인
// 구간의 경과시간을 카운트에서 빼야 한다.

test("createPausableWatchdog: pause 없이 정상 응답이면 그 값을 그대로(워치독 개입 없음)", async () => {
  const w = createPausableWatchdog(Promise.resolve("정상응답"), 50, () => "타임아웃값");
  assert.equal(await w.promise, "정상응답");
});

test("createPausableWatchdog: pause 없이 타임아웃 경과하면 onTimeout() 값(기존 withWatchdog과 동일 계약)", async () => {
  const w = createPausableWatchdog(new Promise(() => {}), 20, () => "타임아웃값");
  assert.equal(await w.promise, "타임아웃값");
});

test("createPausableWatchdog: pause 중엔 원래 타임아웃을 넘겨도 타임아웃 안 남", async () => {
  const w = createPausableWatchdog(new Promise(() => {}), 30, () => "타임아웃값");
  w.pause();
  await new Promise((r) => setTimeout(r, 60)); // 원래 ms(30)의 2배를 대기 — pause라 소진 안 됨
  let settled = false;
  w.promise.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settled, false, "pause 중엔 시간이 흘러도 타임아웃이 발화하면 안 됨");
});

test("createPausableWatchdog: pause → resume 후 남은 시간만큼만 기다리면 타임아웃 발화(경과분 보존)", async () => {
  const w = createPausableWatchdog(new Promise(() => {}), 30, () => "타임아웃값");
  await new Promise((r) => setTimeout(r, 15)); // 절반 소진
  w.pause();
  await new Promise((r) => setTimeout(r, 100)); // pause 중 대량 경과(소진 안 됨)
  w.resume(); // 남은 ~15ms부터 재개
  const r = await w.promise;
  assert.equal(r, "타임아웃값");
});

test("createPausableWatchdog: resume이 남은 시간을 리셋하지 않는다(경과분 누적 보존 — 무한 연장 방지)", async () => {
  const w = createPausableWatchdog(new Promise(() => {}), 25, () => "타임아웃값");
  await new Promise((r) => setTimeout(r, 20)); // 대부분 소진(남은 ~5ms)
  w.pause();
  w.resume(); // 즉시 재개 — pause/resume 자체가 시간을 벌어주면 안 됨
  const t0 = Date.now();
  await w.promise;
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 25, `resume이 remaining을 리셋했다면 25ms 가까이 걸렸을 것 — 실측 ${elapsed}ms`);
});

test("createPausableWatchdog: 정상 promise가 pause 중에 resolve해도 그 값을 받는다(워치독이 정상 흐름을 막지 않음)", async () => {
  let resolveIt;
  const p = new Promise((r) => (resolveIt = r));
  const w = createPausableWatchdog(p, 30, () => "타임아웃값");
  w.pause();
  resolveIt("승인 후 정상 응답");
  const r = await w.promise;
  assert.equal(r, "승인 후 정상 응답");
});

test("createPausableWatchdog: pause()/resume() 중복 호출은 안전(no-op)", async () => {
  const w = createPausableWatchdog(Promise.resolve("ok"), 50, () => "timeout");
  w.pause();
  w.pause();
  w.resume();
  w.resume();
  assert.equal(await w.promise, "ok");
});

test("createEngineSession: onEnded 발화 판단은 shouldNotifyEnded를 경유한다(중복판단 로직 드리프트 방지 회귀락)", () => {
  const src = readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
  const fnStart = src.indexOf("export async function createEngineSession(");
  assert.ok(fnStart >= 0);
  const fnEnd = src.indexOf("\n// ====", fnStart); // 다음 섹션 구분선 전까지
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 6000);
  const occurrences = fnBody.split("shouldNotifyEnded(").length - 1;
  assert.equal(occurrences, 2, "자연종료·catch 두 사망 경로 모두 shouldNotifyEnded를 거쳐야 한다(임의 조건 재작성 금지)");
  assert.match(fnBody, /closedIntentionally = true/, "close()가 의도된 종료를 표시해야 onEnded 오보를 막는다");
});
