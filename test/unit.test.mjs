import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeEdit, isGatedTool } from "../dist/normalize.js";
import { parseVerdict, buildUserMessage, failOpenVerdict } from "../dist/judge.js";
import { computeSpecHash } from "../dist/spec.js";
import { addDefer, activeDeferItems, resolveDefer, unresolvedDefers } from "../dist/defer.js";
import { isGated, markGated, resetGate, loadState } from "../dist/state.js";
import { addSpecCase, readSpecCases, clearSpec } from "../dist/spec.js";
import { buildBlockReason, shouldCacheVerdict } from "../dist/hook.js";
import { buildPreCommand, upgradeKeylessHooks } from "../dist/install.js";
import { serializeEvent, parseEvents, computeMetrics, logEvent } from "../dist/metrics.js";
import { readFileSync } from "node:fs";

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

test("failOpenVerdict: 판정 실패 시 failOpen=true pass 반환(사유 포함)", () => {
  const v = failOpenVerdict(new Error("network down"));
  assert.equal(v.verdict, "pass");
  assert.equal(v.failOpen, true);
  assert.match(v.reason, /fail-open/);
  assert.match(v.reason, /network down/);
});

test("parseVerdict: 정상 판정 결과엔 failOpen 미설정(falsy)", () => {
  const v = parseVerdict('{"verdict":"pass","missing":[],"reason":"ok"}');
  assert.ok(!v.failOpen);
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

test("shouldCacheVerdict: 정상 pass만 캐시, fail-open·block은 캐시 안 함", () => {
  assert.equal(shouldCacheVerdict({ verdict: "pass", missing: [], reason: "ok" }), true);
  // fail-open pass는 캐시 제외 (일시 장애가 작업단위 내내 게이트 무력화 방지)
  assert.equal(
    shouldCacheVerdict({ verdict: "pass", missing: [], reason: "x", failOpen: true }),
    false,
  );
  assert.equal(shouldCacheVerdict({ verdict: "block", missing: [], reason: "y" }), false);
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

test("buildPreCommand: useKey면 $HOME 기반 키주입 prefix, 아니면 기본", () => {
  const withKey = buildPreCommand("/x/dist/cli.js", true);
  assert.match(withKey, /ANTHROPIC_API_KEY/);
  assert.match(withKey, /\$HOME\/\.gbc\/api-key/); // 셸 확장 경로
  assert.doesNotMatch(withKey, /\/home\//); // 하드코딩 홈경로 금지
  assert.match(withKey, /hook pre-tool-use/);
  const noKey = buildPreCommand("/x/dist/cli.js", false);
  assert.doesNotMatch(noKey, /ANTHROPIC_API_KEY/);
  assert.match(noKey, /hook pre-tool-use/);
});

test("buildPreCommand: cliPath의 셸 메타문자를 이스케이프(명령 인젝션 방지)", () => {
  const cmd = buildPreCommand('/p/a"; rm -rf /; echo "/dist/cli.js', false);
  // " 가 \" 로 이스케이프돼 더블쿼트를 벗어나지 못함
  assert.ok(cmd.includes('\\"'));
  assert.ok(!/[^\\]";\s*rm/.test(cmd)); // 비이스케이프 '"; rm' breakout 없음
  // 백틱·$ 도 이스케이프
  const cmd2 = buildPreCommand("/p/`whoami`/$X/cli.js", false);
  assert.ok(cmd2.includes("\\`"));
  assert.ok(cmd2.includes("\\$X"));
});

test("upgradeKeylessHooks: 기존 keyless hook을 키주입 버전으로 업그레이드(멱등)", () => {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [{ type: "command", command: 'node "/x/dist/cli.js" hook pre-tool-use' }],
        },
      ],
    },
  };
  const n = upgradeKeylessHooks(settings, "/x/dist/cli.js", true);
  assert.equal(n, 1); // 1건 업그레이드
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /ANTHROPIC_API_KEY/);
  // 이미 키주입됨 → 재업그레이드 안 함(멱등)
  assert.equal(upgradeKeylessHooks(settings, "/x/dist/cli.js", true), 0);
});

test("serializeEvent: 한 줄 JSON으로 직렬화 + parseEvents 라운드트립", () => {
  const e = {
    at: "2026-06-21T00:00:00.000Z",
    session: "sess-1",
    specHash: "abc",
    kind: "gate",
    tool: "Edit",
    decision: "block",
    missing: ["중복 이메일", "비번 길이"],
    deferCount: 0,
    specCount: 2,
  };
  const line = serializeEvent(e);
  assert.equal(line.includes("\n"), false); // 단일 라인
  const back = parseEvents(line);
  assert.equal(back.length, 1);
  assert.equal(back[0].kind, "gate");
  assert.equal(back[0].decision, "block");
  assert.deepEqual(back[0].missing, ["중복 이메일", "비번 길이"]);
  assert.equal(back[0].specCount, 2);
});

test("serializeEvent: 과대 missing[]을 캡해 라인 길이 4096 미만 보장", () => {
  const e = {
    at: "2026-06-21T00:00:00.000Z",
    session: "s",
    specHash: "h",
    kind: "gate",
    decision: "block",
    missing: Array.from({ length: 200 }, (_, i) => "x".repeat(500) + i),
  };
  const line = serializeEvent(e);
  assert.ok(line.length < 4096, `라인 길이 ${line.length} < 4096`);
  // 캡 후에도 유효 JSON으로 파싱돼야 함
  const back = parseEvents(line);
  assert.equal(back.length, 1);
});

test("parseEvents: 멀티라인 jsonl 파싱 + 깨진/빈 줄 skip", () => {
  const raw = [
    JSON.stringify({ at: "t1", session: "", specHash: "h", kind: "defer-add" }),
    "", // 빈 줄
    "{깨진 json", // 파싱 실패
    JSON.stringify({ at: "t2", session: "", specHash: "h", kind: "spec-add" }),
    "   ", // 공백 줄
  ].join("\n");
  const evs = parseEvents(raw);
  assert.equal(evs.length, 2);
  assert.deepEqual(
    evs.map((e) => e.kind),
    ["defer-add", "spec-add"],
  );
});

test("parseEvents: 빈/공백 입력은 빈 배열", () => {
  assert.deepEqual(parseEvents(""), []);
  assert.deepEqual(parseEvents("   \n  \n"), []);
});

test("computeMetrics M3: 작업단위(session)별 edit 반복 집계", () => {
  const evs = [
    // session A: 3 edits (block, block, pass)
    { at: "t1", session: "A", specHash: "h1", kind: "gate", decision: "block", missing: ["x"] },
    { at: "t2", session: "A", specHash: "h1", kind: "gate", decision: "block", missing: [] },
    { at: "t3", session: "A", specHash: "h1", kind: "gate", decision: "pass" },
    // session B: 1 edit (pass)
    { at: "t4", session: "B", specHash: "h2", kind: "gate", decision: "pass" },
  ];
  const m = computeMetrics(evs);
  assert.equal(m.m3.workUnits, 2);
  assert.equal(m.m3.totalEdits, 4);
  assert.equal(m.m3.avgEditsPerUnit, 2); // 4/2
  assert.equal(m.m3.maxEditsPerUnit, 3);
  assert.equal(m.m3.multiEditUnits, 1); // A만 >1
});

test("computeMetrics M2: 게이트적중(Σmissing) vs 도중발견(defer-add)", () => {
  const evs = [
    { at: "t1", session: "A", specHash: "h", kind: "gate", decision: "block", missing: ["a", "b"] },
    { at: "t2", session: "A", specHash: "h", kind: "gate", decision: "block", missing: ["c"] },
    { at: "t3", session: "", specHash: "h", kind: "defer-add" },
    { at: "t4", session: "A", specHash: "h", kind: "gate", decision: "pass" },
  ];
  const m = computeMetrics(evs);
  assert.equal(m.m2.gateCaught, 3); // a,b,c
  assert.equal(m.m2.blocks, 2);
  assert.equal(m.m2.deferred, 1);
  assert.equal(m.m2.midDiscoveryRatio, 0.25); // 1/(3+1)
});

test("computeMetrics M1: first pass 이후 churn만 계수(이전 변이 제외)", () => {
  const evs = [
    { at: "t1", session: "", specHash: "h", kind: "spec-add" }, // pass 이전 → 제외
    { at: "t2", session: "A", specHash: "h", kind: "gate", decision: "pass" }, // 경계
    { at: "t3", session: "", specHash: "h", kind: "spec-add" }, // 이후 → churn
    { at: "t4", session: "", specHash: "h", kind: "gate-reset" }, // 이후 → churn + reset
    { at: "t5", session: "", specHash: "h2", kind: "spec-add" }, // pass 없는 specHash → 제외
  ];
  const m = computeMetrics(evs);
  assert.equal(m.m1.resets, 1);
  assert.equal(m.m1.churnAfterPass, 2); // t3 spec-add + t4 gate-reset
  assert.match(m.m1.note, /A-mode/);
});

test("computeMetrics M1: 빈 specHash('')는 churn에서 제외(교차세션 합산 방지)", () => {
  // 빈-스펙 작업단위는 specHash=""로 기록됨 — 무관 세션 이벤트가 한 버킷에 합산되면 안 됨
  const evs = [
    { at: "t1", session: "A", specHash: "", kind: "gate", decision: "pass" },
    { at: "t2", session: "", specHash: "", kind: "defer-add" },
    { at: "t3", session: "", specHash: "", kind: "gate-reset" },
    { at: "t4", session: "", specHash: "", kind: "spec-add" },
  ];
  const m = computeMetrics(evs);
  assert.equal(m.m1.churnAfterPass, 0); // "" 버킷 전체 제외
  assert.equal(m.m1.resets, 1); // resets 자체 카운트는 유지
  // 비어있지 않은 specHash는 정상 churn 집계
  const evs2 = [
    { at: "t1", session: "A", specHash: "h", kind: "gate", decision: "pass" },
    { at: "t2", session: "", specHash: "h", kind: "spec-add" },
  ];
  assert.equal(computeMetrics(evs2).m1.churnAfterPass, 1);
});

test("computeMetrics: 빈 입력 안전(0, 0으로 나눔 없음)", () => {
  const m = computeMetrics([]);
  assert.equal(m.totalEvents, 0);
  assert.equal(m.m3.avgEditsPerUnit, 0);
  assert.equal(m.m2.midDiscoveryRatio, 0);
  assert.equal(m.m1.churnAfterPass, 0);
});

test("logEvent: events.jsonl에 append → parseEvents/computeMetrics 라운드트립", () => {
  const dir = tmp();
  try {
    logEvent(dir, { at: "t1", session: "S", specHash: "h", kind: "gate", tool: "Edit", decision: "block", missing: ["케이스A"] });
    logEvent(dir, { at: "t2", session: "S", specHash: "h", kind: "gate", tool: "Edit", decision: "pass" });
    logEvent(dir, { at: "t3", session: "", specHash: "h", kind: "defer-add" });
    const raw = readFileSync(join(dir, ".gbc", "events.jsonl"), "utf8");
    const evs = parseEvents(raw);
    assert.equal(evs.length, 3);
    const m = computeMetrics(evs);
    assert.equal(m.m3.totalEdits, 2); // gate 이벤트 2건
    assert.equal(m.m2.gateCaught, 1); // 케이스A
    assert.equal(m.m2.deferred, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logEvent: GBC_NO_METRICS=1이면 기록 안 함(opt-out)", () => {
  const dir = tmp();
  const prev = process.env.GBC_NO_METRICS;
  process.env.GBC_NO_METRICS = "1";
  try {
    logEvent(dir, { at: "t1", session: "S", specHash: "h", kind: "gate", decision: "pass" });
    let exists = true;
    try {
      readFileSync(join(dir, ".gbc", "events.jsonl"), "utf8");
    } catch {
      exists = false;
    }
    assert.equal(exists, false); // 파일 미생성
  } finally {
    if (prev === undefined) delete process.env.GBC_NO_METRICS;
    else process.env.GBC_NO_METRICS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
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
