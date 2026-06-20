import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeEdit, isGatedTool } from "../dist/normalize.js";
import { parseVerdict, buildUserMessage } from "../dist/judge.js";
import { computeSpecHash } from "../dist/spec.js";
import { addDefer, activeDeferItems, resolveDefer, unresolvedDefers } from "../dist/defer.js";
import { isGated, markGated, resetGate, loadState } from "../dist/state.js";
import { addSpecCase, readSpecCases, clearSpec } from "../dist/spec.js";
import { buildBlockReason } from "../dist/hook.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "gbc-test-"));
}

test("isGatedTool: Edit/Write/MultiEdit만 게이트 대상", () => {
  assert.equal(isGatedTool("Edit"), true);
  assert.equal(isGatedTool("Write"), true);
  assert.equal(isGatedTool("MultiEdit"), true);
  assert.equal(isGatedTool("Read"), false);
  assert.equal(isGatedTool("Bash"), false);
});

test("normalizeEdit: Edit는 -/+ diff로", () => {
  const out = normalizeEdit("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" });
  assert.match(out, /a\.ts/);
  assert.match(out, /- x/);
  assert.match(out, /\+ y/);
});

test("normalizeEdit: Write는 전체 작성", () => {
  const out = normalizeEdit("Write", { file_path: "b.ts", content: "hello" });
  assert.match(out, /전체 작성/);
  assert.match(out, /\+ hello/);
});

test("normalizeEdit: MultiEdit는 각 편집 나열", () => {
  const out = normalizeEdit("MultiEdit", {
    file_path: "c.ts",
    edits: [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ],
  });
  assert.match(out, /편집 1/);
  assert.match(out, /편집 2/);
});

test("parseVerdict: JSON 추출 + block/pass 정규화", () => {
  const v = parseVerdict('쓰레기 {"verdict":"block","missing":["x"],"reason":"r"} 뒤');
  assert.equal(v.verdict, "block");
  assert.deepEqual(v.missing, ["x"]);
  assert.equal(v.reason, "r");
});

test("parseVerdict: 알 수 없는 verdict는 pass로", () => {
  const v = parseVerdict('{"verdict":"maybe"}');
  assert.equal(v.verdict, "pass");
});

test("buildUserMessage: defer 없으면 (없음)", () => {
  const m = buildUserMessage("plan", "edit", []);
  assert.match(m, /\(없음\)/);
});

test("buildUserMessage: defer 항목 나열", () => {
  const m = buildUserMessage("plan", "edit", ["케이스A"]);
  assert.match(m, /- 케이스A/);
});

test("computeSpecHash: 동일 입력 동일 해시, 변경 시 다른 해시", () => {
  assert.equal(computeSpecHash("abc"), computeSpecHash("abc"));
  assert.notEqual(computeSpecHash("abc"), computeSpecHash("abd"));
});

test("defer-registry: add → active → resolve 흐름", () => {
  const dir = tmp();
  try {
    addDefer(dir, "비밀번호 8자 검증");
    addDefer(dir, "중복 이메일 차단");
    assert.deepEqual(activeDeferItems(dir).sort(), ["비밀번호 8자 검증", "중복 이메일 차단"].sort());
    // 텍스트 부분 매칭 해결
    const r = resolveDefer(dir, "비밀번호");
    assert.ok(r);
    assert.equal(activeDeferItems(dir).length, 1);
    assert.equal(unresolvedDefers(dir).length, 1);
    // 인덱스 해결
    resolveDefer(dir, "2");
    assert.equal(activeDeferItems(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec-store: addSpecCase → readSpecCases → clearSpec 흐름", () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "로그인 빈 자격증명 거부");
    addSpecCase(dir, "중복 이메일 인라인 에러");
    const cases = readSpecCases(dir);
    assert.equal(cases.length, 2);
    assert.ok(cases.some((c) => c.includes("빈 자격증명")));
    assert.ok(cases.some((c) => c.includes("중복 이메일")));
    // clear 후 케이스 0
    clearSpec(dir);
    assert.equal(readSpecCases(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addSpecCase: 멀티라인·장문 입력을 한 줄로 정규화", () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "케이스\n둘째 줄\n셋째 줄");
    let cases = readSpecCases(dir);
    assert.equal(cases.length, 1); // 줄바꿈→공백 → 한 줄로 합쳐짐
    assert.match(cases[0], /케이스 둘째 줄 셋째 줄/);
    // 길이 상한(500자) 절단
    addSpecCase(dir, "x".repeat(1000));
    cases = readSpecCases(dir);
    assert.ok(cases[1].length <= 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildBlockReason: 시나리오 미지정이면 도출·등록 루프를 지시", () => {
  const r = buildBlockReason(
    { verdict: "block", missing: [], reason: "시나리오 미지정" },
    true, // specEmpty
    ".gbc/spec.md",
  );
  assert.match(r, /도출/); // 에이전트에게 시나리오 도출 지시
  assert.match(r, /gbc spec add/); // 등록 경로 안내
  assert.doesNotMatch(r, /gbc defer add/); // 누락 경로 메시지는 아님
});

test("buildBlockReason: 침묵 누락이면 defer 등록을 안내", () => {
  const r = buildBlockReason(
    { verdict: "block", missing: ["중복 이메일"], reason: "형제 케이스 누락" },
    false, // specEmpty
    "scratch.md",
  );
  assert.match(r, /gbc defer add/);
  assert.match(r, /중복 이메일/); // 누락 케이스 표시
});

test("gate-state: markGated/isGated/reset 작업단위 1회 캐시", () => {
  const dir = tmp();
  try {
    const h1 = computeSpecHash("spec v1");
    assert.equal(isGated(dir, h1), false);
    markGated(dir, h1, "ok");
    assert.equal(isGated(dir, h1), true);
    // 명세가 바뀌면(다른 해시) 미게이트로 간주 → 재게이트
    const h2 = computeSpecHash("spec v2");
    assert.equal(isGated(dir, h2), false);
    // 리셋하면 다시 미게이트
    markGated(dir, h1, "ok");
    resetGate(dir);
    assert.equal(isGated(dir, h1), false);
    assert.ok(loadState(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
