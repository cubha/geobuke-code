// gate-core evaluateGate 분기별 GateDecision 단정 (0.7.0 A1 ST1).
// 이 테스트가 preToolUseBody 오케스트레이션 추출의 *실제 회귀락*이다 — 골든replay는 judge()만,
// 248 단위는 순수 export 헬퍼만 커버해 이 분기 로직엔 커버가 0이었다(advisor 지적, 실측 확인).
// 모델·디스크 없이 결정론 검증: judge/loadPlanSpec/isGated 등을 fake로 주입한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate } from "../dist/gate-core.js";

function makeDeps(over = {}) {
  return {
    judge: over.judge ?? (async () => ({ verdict: "pass", missing: [], reason: "ok" })),
    loadPlanSpec: over.loadPlanSpec ?? (() => ({ text: "케이스 A 로그인 검증\n케이스 B 중복 이메일", source: ".gbc/spec.md" })),
    isGated: over.isGated ?? (() => false),
    isGoldenCapture: over.isGoldenCapture ?? (() => false),
    activeDeferItems: over.activeDeferItems ?? (() => []),
    resolvedDeferItems: over.resolvedDeferItems ?? (() => []),
    refreshDuringJudge: over.refreshDuringJudge,
  };
}
function makeInput(over = {}) {
  return {
    toolName: over.toolName ?? "Edit",
    toolInput: over.toolInput ?? { file_path: "src/foo.ts", old_string: "a", new_string: "b" },
    cwd: over.cwd ?? "/tmp/gate-core-test",
    session: over.session ?? "sess1",
    env: over.env ?? {},
  };
}
/** judge 호출 여부·횟수를 재는 스파이. */
function spyJudge(verdict = { verdict: "pass", missing: [], reason: "ok" }) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return verdict;
  };
  return { fn, calls };
}

test("passthrough: 게이트 대상 아닌 도구는 무출력 종료·무계측", async () => {
  const j = spyJudge();
  const d = await evaluateGate(makeInput({ toolName: "Read" }), makeDeps({ judge: j.fn }));
  assert.equal(d.kind, "passthrough");
  assert.equal(d.output.mode, "exit-silent");
  assert.equal(d.event, undefined, "passthrough는 이벤트 미기록");
  assert.deepEqual(d.effects, {}, "부수효과 없음");
  assert.equal(j.calls.length, 0, "judge 미호출");
});

test("bypass: GBC_NO_GATE=1은 logBypass+bypass 이벤트, markGated/enqueue 안 함", async () => {
  const j = spyJudge();
  const d = await evaluateGate(makeInput({ env: { GBC_NO_GATE: "1" } }), makeDeps({ judge: j.fn }));
  assert.equal(d.kind, "bypass");
  assert.equal(d.output.mode, "exit-silent");
  assert.equal(d.effects.logBypass, true);
  assert.equal(d.effects.markGated, undefined);
  assert.equal(d.effects.enqueueScope, undefined);
  assert.equal(d.event.kind, "bypass");
  assert.equal(d.event.tool, "Edit");
  assert.equal(j.calls.length, 0, "우회는 judge 미호출");
});

test("doc-skip: 문서 확장자는 judge 미호출 즉시 pass, event.decision=doc-skip·specHash=''", async () => {
  const j = spyJudge();
  const refresh = spyJudge();
  const d = await evaluateGate(
    makeInput({ toolInput: { file_path: "README.md", old_string: "x", new_string: "y" } }),
    makeDeps({ judge: j.fn, refreshDuringJudge: async () => { refresh.calls.push([]); } }),
  );
  assert.equal(d.kind, "doc-skip");
  assert.equal(d.output.mode, "exit-gate");
  assert.equal(d.output.permission, undefined, "doc-skip은 notice-only(permission 없음)");
  assert.equal(d.event.decision, "doc-skip");
  assert.equal(d.event.specHash, "");
  assert.equal(j.calls.length, 0, "doc-skip은 judge 미호출");
  assert.equal(refresh.calls.length, 0, "doc-skip 경로엔 버전 refresh 네트워크 금지(0.2.7)");
});

test("cached: 명세 있고 isGated=true면 judge 미호출·markGated/enqueue 안 함", async () => {
  const j = spyJudge();
  const refresh = spyJudge();
  const d = await evaluateGate(
    makeInput(),
    makeDeps({ judge: j.fn, isGated: () => true, refreshDuringJudge: async () => { refresh.calls.push([]); } }),
  );
  assert.equal(d.kind, "cached");
  assert.equal(d.output.mode, "exit-gate");
  assert.equal(d.output.permission, undefined);
  assert.equal(d.event.decision, "cached");
  assert.equal(d.effects.markGated, undefined);
  assert.equal(d.effects.enqueueScope, undefined);
  assert.equal(j.calls.length, 0, "cached는 judge 미호출");
  assert.equal(refresh.calls.length, 0, "cached 경로엔 버전 refresh 네트워크 금지(0.2.7)");
});

test("빈 명세는 isGated=true여도 캐시 조회 안 함 — judge 재판정(영구우회 방지)", async () => {
  const j = spyJudge();
  const d = await evaluateGate(
    makeInput(),
    makeDeps({ judge: j.fn, loadPlanSpec: () => ({ text: "   ", source: ".gbc/spec.md" }), isGated: () => true }),
  );
  assert.notEqual(d.kind, "cached", "빈-spec은 cached 경로로 새면 안 됨");
  assert.equal(j.calls.length, 1, "빈 명세는 항상 judge 재판정");
});

test("pass 정상: markGated+enqueueScope, event.decision=pass, exit-gate notice-only", async () => {
  const j = spyJudge({ verdict: "pass", missing: [], reason: "형제 케이스 모두 다룸" });
  const refresh = spyJudge();
  const d = await evaluateGate(
    makeInput(),
    makeDeps({ judge: j.fn, refreshDuringJudge: async () => { refresh.calls.push([]); } }),
  );
  assert.equal(d.kind, "pass");
  assert.equal(d.output.mode, "exit-gate");
  assert.equal(d.output.permission, undefined, "정상 pass는 permission 없음(자동승인 X)");
  assert.ok(d.effects.markGated, "명세 있는 pass는 markGated");
  assert.ok(d.effects.markGated.specHash, "specHash 포함");
  assert.ok(d.effects.enqueueScope, "pass는 scope 큐잉");
  assert.equal(d.effects.enqueueScope.toolName, "Edit");
  assert.equal(d.event.decision, "pass");
  assert.equal(j.calls.length, 1);
  assert.equal(refresh.calls.length, 1, "judge 경로에서만 버전 refresh 발화");
});

test("pass 빈-명세: markGated 안 함(상수 hash 영구우회 방지)·enqueue는 함·event.specHash=''", async () => {
  const j = spyJudge({ verdict: "pass", missing: [], reason: "사소한 편집" });
  const d = await evaluateGate(
    makeInput(),
    makeDeps({ judge: j.fn, loadPlanSpec: () => ({ text: "", source: ".gbc/spec.md" }) }),
  );
  assert.equal(d.kind, "pass");
  assert.equal(d.effects.markGated, undefined, "빈 명세 pass는 절대 캐시 안 함");
  assert.ok(d.effects.enqueueScope, "enqueue는 명세 무관");
  assert.equal(d.event.specHash, "", "빈 명세는 계측 해시 센티넬 ''");
});

test("fail-open: emit-direct+allow, systemMessage 고지, markGated/enqueue/golden 안 함", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "pass", missing: [], reason: "타임아웃", failOpen: true }),
      isGoldenCapture: () => true, // 켜져 있어도 fail-open은 캡처 안 함
    }),
  );
  assert.equal(d.kind, "fail-open");
  assert.equal(d.output.mode, "emit-direct", "fail-open은 notice 미첨부 직접 emit");
  assert.equal(d.output.permission.decision, "allow");
  assert.match(d.output.userMessage, /fail-open/, "판정 실패 고지 systemMessage");
  assert.ok(d.effects.logFailOpen, "failopen.log 계측");
  assert.equal(d.effects.markGated, undefined, "fail-open은 캐시 제외");
  assert.equal(d.effects.enqueueScope, undefined, "fail-open은 scope 큐잉 안 함");
  assert.equal(d.effects.goldenCapture, undefined, "fail-open은 골든 캡처 제외");
  assert.equal(d.event.decision, "failopen");
});

test("block ask: pendingReview 기록, permission=ask, reason에 buildBlockReason·missing 반영", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({ judge: async () => ({ verdict: "block", missing: ["케이스 B 중복 이메일"], reason: "형제 누락" }) }),
  );
  assert.equal(d.kind, "block");
  assert.equal(d.output.mode, "exit-gate");
  assert.equal(d.output.permission.decision, "ask");
  assert.match(d.output.permission.reason, /거북이 게이트/);
  assert.match(d.output.permission.reason, /케이스 B 중복 이메일/, "missing이 사유에 표면화");
  assert.deepEqual(d.effects.pendingReview.missing, ["케이스 B 중복 이메일"]);
  assert.equal(d.effects.pendingReview.source, ".gbc/spec.md");
  assert.equal(d.event.decision, "block");
  assert.deepEqual(d.event.missing, ["케이스 B 중복 이메일"]);
});

test("block deny: GBC_BLOCK_MODE=deny면 permission.decision=deny", async () => {
  const d = await evaluateGate(
    makeInput({ env: { GBC_BLOCK_MODE: "deny" } }),
    makeDeps({ judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }) }),
  );
  assert.equal(d.output.permission.decision, "deny");
});

test("block missing 없음: pendingReview 미기록(검토할 케이스 없음)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({ judge: async () => ({ verdict: "block", missing: [], reason: "시나리오 미지정" }) }),
  );
  assert.equal(d.kind, "block");
  assert.equal(d.effects.pendingReview, undefined, "missing 없으면 pending 기록 안 함");
});

test("golden capture: isGoldenCapture=true·non-failopen이면 goldenCapture 디스크립터(tool·edit·spec·expected)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "pass", missing: [], reason: "ok" }),
      isGoldenCapture: () => true,
    }),
  );
  assert.ok(d.effects.goldenCapture, "골든 캡처 디스크립터");
  assert.equal(d.effects.goldenCapture.tool, "Edit");
  assert.ok(d.effects.goldenCapture.edit, "정규화된 편집 본문");
  assert.ok(d.effects.goldenCapture.spec, "명세 스냅샷");
  assert.equal(d.effects.goldenCapture.expected.verdict, "pass");
});

test("golden capture: block verdict도 캡처된다(원본은 pass/block 분기 *전*에 캡처) — pendingReview와 공존", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
      isGoldenCapture: () => true,
    }),
  );
  assert.equal(d.kind, "block");
  assert.ok(d.effects.goldenCapture, "block도 골든 캡처(decisionFlip 회귀락은 양방향)");
  assert.equal(d.effects.goldenCapture.expected.verdict, "block");
  assert.deepEqual(d.effects.goldenCapture.expected.missing, ["케이스 A 로그인 검증"]);
  assert.ok(d.effects.pendingReview, "golden과 pendingReview는 같은 block 판정에서 공존");
});
