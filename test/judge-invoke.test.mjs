// judge() opts.invoke seam (2026-08-07, RCA 후속 — judgeReviewed/judgeScope/judgeM1Violation과
// 동형). LLM 없이 게이트 판정 파서·filterMissingBySpec 배선·fail-open 매핑을 결정론 검증한다.
import { GATE_API_LIMITS, BATCH_API_LIMITS } from "../dist/judge.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { judge } from "../dist/judge.js";

test("judge: opts.invoke가 있으면 transport 선택을 우회하고 그대로 호출한다", async () => {
  const calls = [];
  const invoke = async (system, user) => {
    calls.push({ system, user });
    return '{"verdict":"pass","missing":[],"reason":"ok"}';
  };
  const v = await judge("케이스 A", "edit", [], [], { invoke });
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /게이트/, "GATE_SYSTEM이 그대로 전달됨");
  assert.match(calls[0].user, /케이스 A/, "buildUserMessage로 구성된 user가 전달됨");
  assert.equal(v.verdict, "pass");
});

test("judge: opts.invoke 응답이 filterMissingBySpec을 정상 통과한다(명세 원문 인용 케이스는 유지)", async () => {
  const invoke = async () => '{"verdict":"block","missing":["케이스 A 로그인 검증"],"reason":"누락"}';
  const v = await judge("케이스 A 로그인 검증\n케이스 B 중복 이메일", "edit", [], [], { invoke });
  assert.equal(v.verdict, "block");
  assert.deepEqual(v.missing, ["케이스 A 로그인 검증"]);
});

test("judge: opts.invoke 응답의 missing이 명세에 없는 발명 항목이면 드롭되고 reason에 고지", async () => {
  const invoke = async () => '{"verdict":"block","missing":["명세에 없는 발명 케이스"],"reason":"누락"}';
  const v = await judge("케이스 A 로그인 검증", "edit", [], [], { invoke });
  assert.deepEqual(v.missing, [], "명세 무근거 항목은 드롭");
  assert.match(v.reason, /명세 무근거 missing.*제외/);
});

test("judge: opts.invoke가 throw하면 fail-open(pass, failOpen:true) — 정당한 block 자리에 조용히 앉지 않도록 값 검사 대상", async () => {
  const invoke = async () => {
    throw new Error("network down");
  };
  const v = await judge("케이스 A", "edit", [], [], { invoke });
  assert.equal(v.verdict, "pass");
  assert.equal(v.failOpen, true);
  assert.match(v.reason, /network down/);
});

test("judge: opts.invoke가 파싱 불가 텍스트를 반환해도 fail-open으로 흡수(정상 판정으로 오인 안 함)", async () => {
  const invoke = async () => "이건 JSON이 아님";
  const v = await judge("케이스 A", "edit", [], [], { invoke });
  assert.equal(v.failOpen, true);
});

// ── F-15(0.12.0): API 상한을 호출 경로별로 가른다 ──
// 게이트(judge)는 PreToolUse 동기 차단이라 짧은 상한 + 적은 재시도가 맞지만, judgeReviewed는
// MAX_REVIEW_CODE(12000자) 코드 독해라 같은 상한을 물리면 정당한 판정이 unverifiable로 강등된다
// (scope-critic 지적, 2026-08-09). 이 락은 "하나로 합치자"는 향후 단순화를 막는다.

test("API 상한: 게이트 경로가 배치 경로보다 엄격하다(동기 차단이므로)", () => {
  assert.ok(
    GATE_API_LIMITS.timeoutMs < BATCH_API_LIMITS.timeoutMs,
    `게이트 상한이 배치보다 길면 안 됨: gate=${GATE_API_LIMITS.timeoutMs} batch=${BATCH_API_LIMITS.timeoutMs}`,
  );
  assert.ok(GATE_API_LIMITS.maxRetries <= BATCH_API_LIMITS.maxRetries, "게이트는 재시도로 지연을 사지 않는다");
});

test("API 상한: 배치 경로는 코드 독해가 끝날 만큼 넉넉하다(judgeReviewed 강등 방지)", () => {
  assert.ok(BATCH_API_LIMITS.timeoutMs >= 60_000, `배치 상한이 너무 짧음: ${BATCH_API_LIMITS.timeoutMs}ms`);
  assert.ok(BATCH_API_LIMITS.maxRetries >= 2, "비차단 경로는 일시적 오류에서 회복력을 산다");
});
