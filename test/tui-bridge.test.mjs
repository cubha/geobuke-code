// 0.9.0 A3a ST4 — src/tui/bridge.ts 순수부(SDK 메시지→TuiEvent 매핑, 승인 프롬프트 분류·해석) 단정.
// 아키텍처 확정 근거(advisor + cli.ts:201 실측): "에이전트가 요청에서 시나리오를 도출해 사용자 검증
// 후 'gbc spec add'로 등록" — y/n/e/d 승인 UI는 gbc 게이트 BLOCK 자체가 아니라, 에이전트가 스스로
// 발화하는 Bash("gbc spec add \"...\"") 호출에 대한 canUseTool pause다. SDK PermissionResult가
// allow/deny 이진이라는 제약 위에서 e(수정 후 승인)=updatedInput 편집, d(defer)=deny+defer 부작용
// 기술자를 반환(실제 addDefer I/O는 이 파일 밖 — 순수함수는 "무엇을 할지"만 기술).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapEngineMessageToTuiEvents,
  classifyApprovalRequest,
  resolveApproval,
  buildGateResultEvent,
  formatEngineFailure,
  formatEngineAbort,
  DeltaAssembler,
} from "../dist/tui/bridge.js";

// ── buildGateResultEvent (gate-sdk.ts onDecision seam이 넘겨주는 GateDecision) ──
// specCount·deferCount는 항상 호출부가 넘긴다 — decision.event.deferCount는 pass/block에만 있고
// cached/doc-skip/bypass(최다빈도 경로)엔 없어 신뢰하면 "실제 defer가 있어도 0" 결함이 남는다
// (자체검토로 발견·수정). 그래서 아래 테스트는 decision.event에 deferCount를 아예 안 담아도
// 함수가 인자로 받은 값을 그대로 쓰는지를 확인한다.

test("buildGateResultEvent: kind=block → APPROVAL_REQUESTED(reason), specCount/deferCount 인자 무관", () => {
  const decision = { kind: "block", output: { mode: "exit-gate", permission: { decision: "ask", reason: "명세에 없는 파일 편집" } }, effects: {} };
  assert.deepEqual(buildGateResultEvent(decision, 4, 1), { type: "APPROVAL_REQUESTED", reason: "명세에 없는 파일 편집" });
});

test("buildGateResultEvent: kind=pass → GATE_RESULT(status:pass, specCount/deferCount는 인자값 그대로)", () => {
  const decision = { kind: "pass", output: { mode: "exit-gate" }, effects: {} };
  assert.deepEqual(buildGateResultEvent(decision, 4, 2), { type: "GATE_RESULT", status: "pass", specCount: 4, deferCount: 2 });
});

test("buildGateResultEvent: doc-skip/cached/bypass/fail-open/passthrough/block-repeat는 전부 pass로 뭉뚱그리고, deferCount는 인자값 그대로(event 미신뢰)", () => {
  // block-repeat(0.9.3 ST2)도 이 목록에 **의식적으로** 포함한다 — emit-direct(allow)라 사용자
  // 관점에선 "통과"고, 안내 문구(userMessage)는 gate-sdk.ts의 gateDecisionToHookOutput이 emit-direct
  // 공통 경로로 systemMessage에 실어 스크롤백에 이미 노출된다(fail-open과 동일 채널) — 상태줄까지
  // 이중고지하지 않는다. scope-critic 지적(2026-07-14): 신규 kind를 이 목록 밖에 방치하면 exhaustiveness
  // 체크 없는 else 캐치올이 "검토된 결정"과 "우연한 상속"을 구분 못 하게 되므로, 목록에 명시해 잠근다.
  for (const kind of ["doc-skip", "cached", "bypass", "fail-open", "passthrough", "block-repeat"]) {
    const decision = { kind, output: { mode: "exit-silent" }, effects: {} }; // event 자체가 없음 — cached 등의 실제 형태
    const ev = buildGateResultEvent(decision, 0, 3);
    assert.equal(ev.type, "GATE_RESULT");
    assert.equal(ev.status, "pass");
    assert.equal(ev.deferCount, 3, `kind=${kind}에서도 인자로 받은 deferCount를 그대로 써야 함(event 결손 무관)`);
  }
});

// ── mapEngineMessageToTuiEvents ──

test("result 메시지 → TURN_END + STATUSLINE_UPDATE(costUsd)", () => {
  const events = mapEngineMessageToTuiEvents({ type: "result", subtype: "success", total_cost_usd: 0.42, num_turns: 3 });
  assert.deepEqual(events, [
    { type: "TURN_END" },
    { type: "STATUSLINE_UPDATE", patch: { costUsd: 0.42 } },
  ]);
});

test("result 메시지에 total_cost_usd 없으면 0으로", () => {
  const events = mapEngineMessageToTuiEvents({ type: "result", subtype: "success" });
  assert.deepEqual(events[1], { type: "STATUSLINE_UPDATE", patch: { costUsd: 0 } });
});

test("result 메시지에 ttft_ms가 있으면 STATUSLINE_UPDATE patch에 lastTtftMs로 포함(0.9.4 ST7 계측)", () => {
  const events = mapEngineMessageToTuiEvents({ type: "result", subtype: "success", total_cost_usd: 0.1, ttft_ms: 1660 });
  assert.deepEqual(events[1], { type: "STATUSLINE_UPDATE", patch: { costUsd: 0.1, lastTtftMs: 1660 } });
});

test("assistant/system/auth_status 등 result가 아닌 메시지는 빈 배열(모델 세부 상태는 TuiState가 다루지 않음)", () => {
  assert.deepEqual(mapEngineMessageToTuiEvents({ type: "assistant" }), []);
  assert.deepEqual(mapEngineMessageToTuiEvents({ type: "system", subtype: "init" }), []);
  assert.deepEqual(mapEngineMessageToTuiEvents({ type: "auth_status" }), []);
  assert.deepEqual(mapEngineMessageToTuiEvents({ type: "stream_event" }), []);
});

// ── classifyApprovalRequest ──

test("classifyApprovalRequest: Bash('gbc spec add \"...\"')는 spec-add로 분류, 케이스 텍스트 추출", () => {
  const ctx = classifyApprovalRequest("Bash", { command: 'gbc spec add "bracketed paste 수신 시 멀티라인 원문 그대로 삽입"' });
  assert.deepEqual(ctx, {
    kind: "spec-add",
    derivedCase: "bracketed paste 수신 시 멀티라인 원문 그대로 삽입",
    rawCommand: 'gbc spec add "bracketed paste 수신 시 멀티라인 원문 그대로 삽입"',
  });
});

test("classifyApprovalRequest: Bash지만 spec add가 아니면 generic", () => {
  assert.deepEqual(classifyApprovalRequest("Bash", { command: "npm test" }), { kind: "generic" });
});

test("classifyApprovalRequest: Bash가 아닌 도구는 generic(y/n 이진 pause로 폴백)", () => {
  assert.deepEqual(classifyApprovalRequest("Edit", { file_path: "a.ts" }), { kind: "generic" });
});

test("classifyApprovalRequest: command가 문자열이 아니거나 없으면 generic(방어)", () => {
  assert.deepEqual(classifyApprovalRequest("Bash", {}), { kind: "generic" });
  assert.deepEqual(classifyApprovalRequest("Bash", { command: 123 }), { kind: "generic" });
});

// ── resolveApproval ──

const specCtx = { kind: "spec-add", derivedCase: "케이스 텍스트", rawCommand: 'gbc spec add "케이스 텍스트"' };
const input = { command: 'gbc spec add "케이스 텍스트"' };

test("resolveApproval(y, spec-add): allow + updatedInput 원본 그대로, defer 부작용 없음", () => {
  const r = resolveApproval("y", specCtx, input);
  assert.deepEqual(r.result, { behavior: "allow", updatedInput: input });
  assert.equal(r.deferText, null);
});

test("resolveApproval(n, spec-add): deny, defer 부작용 없음", () => {
  const r = resolveApproval("n", specCtx, input);
  assert.equal(r.result.behavior, "deny");
  assert.equal(r.deferText, null);
});

test("resolveApproval(e, spec-add): allow + 편집된 명령으로 updatedInput 치환", () => {
  const edited = 'gbc spec add "수정된 케이스"';
  const r = resolveApproval("e", specCtx, input, edited);
  assert.deepEqual(r.result, { behavior: "allow", updatedInput: { ...input, command: edited } });
  assert.equal(r.deferText, null);
});

test("resolveApproval(e, spec-add): 편집 텍스트 미제공 시 rawCommand 그대로(no-op 편집)", () => {
  const r = resolveApproval("e", specCtx, input);
  assert.deepEqual(r.result, { behavior: "allow", updatedInput: { ...input, command: specCtx.rawCommand } });
});

test("resolveApproval(d, spec-add): deny + derivedCase를 defer 부작용으로 반환(실제 addDefer 호출은 이 함수 밖)", () => {
  const r = resolveApproval("d", specCtx, input);
  assert.equal(r.result.behavior, "deny");
  assert.equal(r.deferText, "케이스 텍스트");
});

test("resolveApproval: generic 컨텍스트에선 e/d를 n과 동일하게(고무도장 방지 기본값), y만 allow", () => {
  const genericCtx = { kind: "generic" };
  assert.equal(resolveApproval("y", genericCtx, input).result.behavior, "allow");
  assert.equal(resolveApproval("n", genericCtx, input).result.behavior, "deny");
  assert.equal(resolveApproval("e", genericCtx, input).result.behavior, "deny", "generic엔 편집 대상이 없음");
  assert.equal(resolveApproval("d", genericCtx, input).result.behavior, "deny");
  assert.equal(resolveApproval("d", genericCtx, input).deferText, null, "generic은 derivedCase가 없어 defer 부작용도 없음");
});

test("resolveApproval: 입력을 변형하지 않는다(순수성)", () => {
  const frozenInput = JSON.stringify(input);
  const frozenCtx = JSON.stringify(specCtx);
  resolveApproval("e", specCtx, input, "x");
  assert.equal(JSON.stringify(input), frozenInput);
  assert.equal(JSON.stringify(specCtx), frozenCtx);
});

// ── formatEngineFailure (0.9.1 — runEngine 반환값을 TUI 표시 문구로. app.tsx submit()이 이 반환값을
// 버려서 인증/네트워크 실패가 화면에 안 뜨던 "무응답" 결함의 근본수정) ──

test("formatEngineFailure: isError:false → null(정상 종료, 표시할 실패 없음)", () => {
  assert.equal(formatEngineFailure({ isError: false }), null);
});

test("formatEngineFailure: isError:true + error 있음 → 오류 문구에 error 포함", () => {
  const msg = formatEngineFailure({ isError: true, error: "network timeout" });
  assert.equal(msg, "🐢 오류: network timeout");
});

test("formatEngineFailure: isError:true인데 error 없음(예: subtype≠success) → 폴백 문구", () => {
  const msg = formatEngineFailure({ isError: true });
  assert.equal(msg, "🐢 오류: 알 수 없는 오류로 응답을 완료하지 못했습니다");
});

// auth_status(SDKAuthStatusMessage)는 isError와 독립된 채널이다(engine.ts:175 — result 메시지·throw
// 어느 쪽도 거치지 않고 auth_status만 error를 담아 종료될 수 있음, cli.ts:1052가 이미 이 필드를
// 별도로 노출하는 선례). scope-critic이 지적(2026-07-13 SubTask2 판정, DECISION_CHANGED:yes): isError만
// 보면 이 경로의 인증 실패가 여전히 무응답으로 남는다.

test("formatEngineFailure: isError:false지만 auth.error 있음 → 인증 오류 문구(독립 채널)", () => {
  const msg = formatEngineFailure({ isError: false, auth: { authenticating: false, output: [], error: "invalid api key" } });
  assert.equal(msg, "🐢 인증 오류: invalid api key");
});

test("formatEngineFailure: isError:false + auth 있지만 error 없음 → null(인증 진행중일 뿐 실패 아님)", () => {
  const msg = formatEngineFailure({ isError: false, auth: { authenticating: true, output: ["로그인 중..."] } });
  assert.equal(msg, null);
});

test("formatEngineFailure: isError:false + auth:null → null", () => {
  assert.equal(formatEngineFailure({ isError: false, auth: null }), null);
});

test("formatEngineFailure: isError:true가 auth.error보다 우선(둘 다 있으면 isError 문구)", () => {
  const msg = formatEngineFailure({
    isError: true,
    error: "network timeout",
    auth: { authenticating: false, output: [], error: "invalid api key" },
  });
  assert.equal(msg, "🐢 오류: network timeout");
});

// ── formatEngineAbort (0.9.2 ST2 — Esc 중단은 실패가 아니라 사용자 의도한 취소이므로 formatEngineFailure
// (danger 톤 "🐢 오류:")와 별도 채널·별도 문구·별도 톤(warn)으로 분류한다. app.tsx submit()이 result.aborted를
// formatEngineFailure보다 먼저 확인해 이 문구를 쓴다 — isError/error와는 배타적 필드라 순서 무관하게 안전. ──

test("formatEngineAbort: aborted:true → 중단 문구", () => {
  assert.equal(formatEngineAbort({ aborted: true }), "🐢 중단됨 — 응답 생성을 취소했습니다");
});

test("formatEngineAbort: aborted:false/undefined → null", () => {
  assert.equal(formatEngineAbort({ aborted: false }), null);
  assert.equal(formatEngineAbort({}), null);
});

// ── formatEngineFailure: spawn EPERM/EACCES 진단 배선 (0.9.2 ST6 — runEngine이 rethrow하지 않고
// EngineResult.error 문자열로 반환하는 실제 경로. classifyTuiStartupError는 ink 로딩 크래시(cli.ts
// cmdTui 바깥 catch)만 보고 이 경로는 못 본다 — 그래서 여기서 classifySpawnPermissionError를 직접
// 재사용해 GBC_CLAUDE_PATH 안내가 실제로 화면에 뜨게 한다. ──

test("formatEngineFailure: error가 spawn EPERM이면 원본 대신 GBC_CLAUDE_PATH 진단 문구", () => {
  const msg = formatEngineFailure({ isError: true, error: "Error: spawn EPERM" });
  assert.match(msg, /GBC_CLAUDE_PATH/);
  assert.match(msg, /claude --version/);
});

test("formatEngineFailure: spawn과 무관한 오류는 기존 그대로(원본 오류 문구 보존)", () => {
  const msg = formatEngineFailure({ isError: true, error: "network timeout" });
  assert.equal(msg, "🐢 오류: network timeout");
});

// ===== DeltaAssembler (0.9.4 ST3 — partial 스트리밍 델타 어셈블러) =====
// stream_event(SDKPartialAssistantMessage)의 content_block_delta를 index별로 누적한다. Static
// 커밋-후-불변 모델과의 공존: 이 어셈블러는 "지금까지 누적된 텍스트"를 매 delta마다 반환하고,
// 완성된 assistant 메시지(mapSdkMessage 경로)가 최종 커밋을 맡는다 — 이 어셈블러는 진행 중 표시만
// 책임지고 스스로 커밋하지 않는다(이중출력 방지, braintrust ⑥).

const startEvent = (index, blockType = "text") => ({
  type: "stream_event",
  event: { type: "content_block_start", index, content_block: { type: blockType } },
});
const deltaEvent = (index, text) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
});
const stopEvent = (index) => ({ type: "stream_event", event: { type: "content_block_stop", index } });

test("DeltaAssembler: text_delta 연속 → 누적 텍스트를 매번 반환", () => {
  const a = new DeltaAssembler();
  a.apply(startEvent(0));
  assert.equal(a.apply(deltaEvent(0, "안")), "안");
  assert.equal(a.apply(deltaEvent(0, "녕")), "안녕");
  assert.equal(a.apply(deltaEvent(0, "하세요")), "안녕하세요");
});

test("DeltaAssembler: content_block_stop → 해당 인덱스 버퍼 정리(이후 delta는 처음부터 다시 누적)", () => {
  const a = new DeltaAssembler();
  a.apply(startEvent(0));
  a.apply(deltaEvent(0, "첫turn"));
  a.apply(stopEvent(0));
  // 새 턴이 같은 index=0을 재사용해도(스트리밍은 턴마다 index가 0부터 다시 시작) 이전 텍스트가 안 섞인다.
  a.apply(startEvent(0));
  assert.equal(a.apply(deltaEvent(0, "새turn")), "새turn");
});

test("DeltaAssembler: 서로 다른 index는 독립적으로 누적(멀티블록)", () => {
  const a = new DeltaAssembler();
  a.apply(startEvent(0));
  a.apply(startEvent(1));
  a.apply(deltaEvent(0, "A"));
  a.apply(deltaEvent(1, "B"));
  assert.equal(a.apply(deltaEvent(0, "A2")), "AA2");
  assert.equal(a.apply(deltaEvent(1, "B2")), "BB2");
});

test("DeltaAssembler: content_block_start가 text가 아니면(tool_use 등) 추적하지 않음(null 반환·delta도 무시)", () => {
  const a = new DeltaAssembler();
  a.apply(startEvent(0, "tool_use"));
  assert.equal(a.apply(deltaEvent(0, "무시되어야 함")), null);
});

test("DeltaAssembler: stream_event가 아닌 메시지·text_delta 아닌 델타는 전부 null(무관 메시지 무시)", () => {
  const a = new DeltaAssembler();
  assert.equal(a.apply({ type: "assistant" }), null);
  assert.equal(a.apply({ type: "stream_event", event: { type: "message_start" } }), null);
  assert.equal(
    a.apply({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } } }),
    null,
    "tool_use input의 input_json_delta는 T2 스코프 밖(텍스트만)",
  );
});
