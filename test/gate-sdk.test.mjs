// SDK PreToolUse 어댑터 단정 (0.7.0 A1 ST4). GateDecision→HookJSONOutput 매핑 + 콜백 배선·fail-open.
// ST1 evaluateGate 테스트와 함께 A-mode SDK 경로의 회귀락을 이룬다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateDecisionToHookOutput, makeSdkPreToolUseHook, interpretPauseAnswer, makeStdinPauseCanUseTool } from "../dist/gate-sdk.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "gbc-gate-sdk-"));
}
function makeDeps(over = {}) {
  return {
    judge: over.judge ?? (async () => ({ verdict: "pass", missing: [], reason: "ok" })),
    loadPlanSpec: over.loadPlanSpec ?? (() => ({ text: "케이스 A\n케이스 B", source: ".gbc/spec.md" })),
    isGated: over.isGated ?? (() => false),
    isGoldenCapture: over.isGoldenCapture ?? (() => false),
    activeDeferItems: over.activeDeferItems ?? (() => []),
    resolvedDeferItems: over.resolvedDeferItems ?? (() => []),
    refreshDuringJudge: over.refreshDuringJudge,
    readPendingReview: over.readPendingReview ?? (() => null), // 0.9.3 ST2 — GateDeps 신규 필드
    readCurrentFile: over.readCurrentFile ?? (() => null), // 0.9.3 ST3 — GateDeps 신규 필드
  };
}
function preInput(over = {}) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: over.tool_name ?? "Edit",
    tool_input: over.tool_input ?? { file_path: "src/x.ts", old_string: "a", new_string: "b" },
    tool_use_id: "tu1",
    session_id: over.session_id ?? "sess1",
  };
}

// ===== gateDecisionToHookOutput (순수 매핑) =====

test("exit-silent(passthrough/bypass) → {} (의견 없음)", () => {
  assert.deepEqual(gateDecisionToHookOutput({ output: { mode: "exit-silent" } }), {});
});

test("exit-gate + permission 없음(doc-skip/cached/pass) → {} (allow 통과)", () => {
  assert.deepEqual(gateDecisionToHookOutput({ output: { mode: "exit-gate" } }), {});
});

test("exit-gate + permission ask(block) → hookSpecificOutput ask+reason+additionalContext", () => {
  const o = gateDecisionToHookOutput({ output: { mode: "exit-gate", permission: { decision: "ask", reason: "누락 사유" } } });
  assert.equal(o.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(o.hookSpecificOutput.permissionDecision, "ask");
  assert.equal(o.hookSpecificOutput.permissionDecisionReason, "누락 사유");
  assert.equal(o.hookSpecificOutput.additionalContext, "누락 사유", "additionalContext=사유(stdin 동작 미러)");
});

test("exit-gate + permission deny → permissionDecision deny", () => {
  const o = gateDecisionToHookOutput({ output: { mode: "exit-gate", permission: { decision: "deny", reason: "r" } } });
  assert.equal(o.hookSpecificOutput.permissionDecision, "deny");
});

test("emit-direct(fail-open) → systemMessage 고지 + allow(안내 미첨부)", () => {
  const o = gateDecisionToHookOutput({
    output: { mode: "emit-direct", permission: { decision: "allow", reason: "타임아웃" }, userMessage: "🐢 fail-open 고지" },
  });
  assert.match(o.systemMessage, /fail-open/);
  assert.equal(o.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(o.hookSpecificOutput.permissionDecisionReason, "타임아웃");
});

// ===== makeSdkPreToolUseHook (콜백 배선) =====

test("콜백: block 판정 → deny/ask 반환 + effects 커밋(events.jsonl)", async () => {
  const cwd = tmp();
  try {
    const cb = makeSdkPreToolUseHook(cwd, makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 B"], reason: "형제 누락" }),
    }));
    const out = await cb(preInput(), "tu1", { signal: undefined });
    assert.ok(out.hookSpecificOutput, "block은 hookSpecificOutput 반환");
    assert.ok(["ask", "deny"].includes(out.hookSpecificOutput.permissionDecision));
    assert.ok(existsSync(join(cwd, ".gbc", "events.jsonl")), "effects 커밋(계측 기록)");
    const ev = readFileSync(join(cwd, ".gbc", "events.jsonl"), "utf8");
    assert.match(ev, /"decision":"block"/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("콜백: pass 판정 → {} (통과)", async () => {
  const cwd = tmp();
  try {
    const cb = makeSdkPreToolUseHook(cwd, makeDeps({ judge: async () => ({ verdict: "pass", missing: [], reason: "ok" }) }));
    const out = await cb(preInput(), "tu1", { signal: undefined });
    assert.deepEqual(out, {}, "pass는 의견 없음(통과)");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("콜백: 비-PreToolUse 이벤트 → {} (무관)", async () => {
  const cb = makeSdkPreToolUseHook(tmp());
  const out = await cb({ hook_event_name: "Stop", session_id: "s1" }, undefined, { signal: undefined });
  assert.deepEqual(out, {});
});

// ===== onDecision seam (0.9.0 A3a TUI — engine.ts onMessage와 대칭) =====

test("onDecision: 판정 성공마다 GateDecision을 관측 콜백에 넘긴다(반환값은 무시)", async () => {
  const cwd = tmp();
  try {
    const seen = [];
    const cb = makeSdkPreToolUseHook(
      cwd,
      makeDeps({ judge: async () => ({ verdict: "pass", missing: [], reason: "ok" }) }),
      (decision) => seen.push(decision),
    );
    await cb(preInput(), "tu1", { signal: undefined });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, "pass");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("onDecision: 콜백이 throw해도 훅 응답(hookSpecificOutput)은 정상 반환(engine.ts onMessage와 동일 흡수 규율)", async () => {
  const cwd = tmp();
  try {
    const cb = makeSdkPreToolUseHook(
      cwd,
      makeDeps({ judge: async () => ({ verdict: "block", missing: ["케이스 B"], reason: "형제 누락" }) }),
      () => { throw new Error("TUI 콜백 버그"); },
    );
    const out = await cb(preInput(), "tu1", { signal: undefined });
    assert.ok(out.hookSpecificOutput, "onDecision throw가 훅 판정 흐름을 끊지 않음");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("onDecision: 비-PreToolUse 이벤트에선 호출 안 됨(early return이 evaluateGate보다 앞)", async () => {
  const seen = [];
  const cb = makeSdkPreToolUseHook(tmp(), undefined, (d) => seen.push(d));
  await cb({ hook_event_name: "Stop", session_id: "s1" }, undefined, { signal: undefined });
  assert.equal(seen.length, 0);
});

test("콜백: evaluateGate infra throw → 정형 fail-open(allow + systemMessage)", async () => {
  const cwd = tmp();
  try {
    const cb = makeSdkPreToolUseHook(cwd, makeDeps({
      loadPlanSpec: () => { throw new Error("디스크 실패"); },
    }));
    const out = await cb(preInput(), "tu1", { signal: undefined });
    assert.equal(out.hookSpecificOutput.permissionDecision, "allow", "장수 프로세스 fail-open=allow return");
    assert.match(out.systemMessage, /fail-open/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ===== interpretPauseAnswer / canUseTool pause (ST5) =====

test("interpretPauseAnswer: y/yes(공백·대소문자 무관) → allow + updatedInput(SDK zod 요구)", () => {
  assert.equal(interpretPauseAnswer("y").behavior, "allow");
  assert.equal(interpretPauseAnswer("Y").behavior, "allow");
  assert.equal(interpretPauseAnswer("yes").behavior, "allow");
  assert.equal(interpretPauseAnswer("  YES  ").behavior, "allow");
  // ST7 실측 회귀: allow는 반드시 updatedInput(record)을 담아야 SDK 스키마 통과(누락 시 ZodError).
  const r = interpretPauseAnswer("y", { file_path: "a.ts", content: "x" });
  assert.deepEqual(r.updatedInput, { file_path: "a.ts", content: "x" }, "원본 인자를 updatedInput으로 통과");
  assert.ok("updatedInput" in interpretPauseAnswer("y"), "인자 미지정도 updatedInput 키 존재({}로)");
});

test("interpretPauseAnswer: 빈 입력·n·기타 → deny(기본 거부=고무도장 방지)", () => {
  assert.equal(interpretPauseAnswer("").behavior, "deny");
  assert.equal(interpretPauseAnswer("n").behavior, "deny");
  assert.equal(interpretPauseAnswer("무엇이든").behavior, "deny");
  assert.ok(interpretPauseAnswer("").message, "deny는 사유 포함");
});

test("makeStdinPauseCanUseTool: autoAllow=true는 프롬프트 없이 즉시 allow + updatedInput(비대화형)", async () => {
  const canUse = makeStdinPauseCanUseTool({ autoAllow: true });
  const r = await canUse("Bash", { command: "ls" }, { signal: undefined });
  assert.equal(r.behavior, "allow");
  assert.deepEqual(r.updatedInput, { command: "ls" }, "autoAllow도 원본 인자를 updatedInput으로(SDK zod)");
});
