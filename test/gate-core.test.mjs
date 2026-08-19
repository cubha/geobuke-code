// gate-core evaluateGate 분기별 GateDecision 단정 (0.7.0 A1 ST1).
// 이 테스트가 preToolUseBody 오케스트레이션 추출의 *실제 회귀락*이다 — 골든replay는 judge()만,
// 248 단위는 순수 export 헬퍼만 커버해 이 분기 로직엔 커버가 0이었다(advisor 지적, 실측 확인).
// 모델·디스크 없이 결정론 검증: judge/loadPlanSpec/isGated 등을 fake로 주입한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, readCurrentFile } from "../dist/gate-core.js";
import { computeSpecHash } from "../dist/spec.js";
import { collectCaseEvidence as realCollectCaseEvidence } from "../dist/evidence.js";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeDeps(over = {}) {
  return {
    judge: over.judge ?? (async () => ({ verdict: "pass", missing: [], reason: "ok" })),
    loadPlanSpec: over.loadPlanSpec ?? (() => ({ text: "케이스 A 로그인 검증\n케이스 B 중복 이메일", source: ".gbc/spec.md" })),
    isGated: over.isGated ?? (() => false),
    isGoldenCapture: over.isGoldenCapture ?? (() => false),
    activeDeferItems: over.activeDeferItems ?? (() => []),
    resolvedDeferItems: over.resolvedDeferItems ?? (() => []),
    refreshDuringJudge: over.refreshDuringJudge,
    readPendingReview: over.readPendingReview ?? (() => null),
    readCurrentFile: over.readCurrentFile ?? (() => null),
    // 기본값 = 매치 없음(빈 배열) — 기존 block 테스트 전부가 evidence 미사용 상태를 그대로 유지하게
    // 한다. ST12 재판정을 검증하는 테스트만 over.collectCaseEvidence로 명시 오버라이드한다.
    collectCaseEvidence: over.collectCaseEvidence ?? (async (_cwd, missing) => missing.map((c) => ({ case: c, context: "", matched: false }))),
    // 0.12.3 P2a — 기본값 = 빈 원장(기존 테스트 전부가 적용이력 미사용 상태를 그대로 유지). 배선을
    // 검증하는 테스트만 over.loadApplied로 명시 오버라이드한다.
    loadApplied: over.loadApplied ?? (() => []),
  };
}
/** makeInput/makeDeps 기본 loadPlanSpec 텍스트의 명세 해시 — 재발화 억제 테스트가 "같은 작업단위"를
 * 흉내내는 데 쓴다(fa-support 도그푸딩 리포트의 형제-침묵누락 반복 발화 오탐, 0.9.3 ST2). */
const DEFAULT_SPEC_HASH = computeSpecHash("케이스 A 로그인 검증\n케이스 B 중복 이메일");
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

// ── P3(0.12.1) — raw old_string을 편집 앵커로 judge에 전달(head 뒤쪽 형제 윈도우 판별용) ──
test("editOldStrings: Edit은 raw old_string을 그대로 opts에 담아 judge에 전달한다", async () => {
  const j = spyJudge();
  await evaluateGate(makeInput({ toolInput: { file_path: "src/foo.ts", old_string: "raw-anchor-text", new_string: "b" } }), makeDeps({ judge: j.fn }));
  assert.deepEqual(j.calls[0][4]?.editOldStrings, ["raw-anchor-text"]);
});

test("editOldStrings: MultiEdit은 edits[].old_string 전부를 담는다", async () => {
  const j = spyJudge();
  await evaluateGate(
    makeInput({
      toolName: "MultiEdit",
      toolInput: { file_path: "src/foo.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
    }),
    makeDeps({ judge: j.fn }),
  );
  assert.deepEqual(j.calls[0][4]?.editOldStrings, ["a", "c"]);
});

test("editOldStrings: Write(전체 덮어쓰기)는 항상 빈 배열 — old_string 자체가 없고 앵커도 성립하지 않는다", async () => {
  const j = spyJudge();
  await evaluateGate(makeInput({ toolName: "Write", toolInput: { file_path: "src/foo.ts", content: "new file body" } }), makeDeps({ judge: j.fn }));
  assert.deepEqual(j.calls[0][4]?.editOldStrings, []);
});

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

// ── 0.9.3 ST3: judge에 [현재 파일 상태] 클립 전달 ──
// fa-support 도그푸딩 리포트: judge가 diff만 보고 판정해 파일에 이미 구현된 형제 케이스를 침묵
// 누락으로 오분류하는 근본원인. deps.readCurrentFile(filePath)로 파일 현재 내용을 읽어 judge의
// 5번째 인자로 전달한다.

test("judge 호출 시 readCurrentFile(file_path) 결과를 opts.currentFileContent로 전달", async () => {
  const j = spyJudge();
  await evaluateGate(
    makeInput({ toolInput: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } }),
    makeDeps({ judge: j.fn, readCurrentFile: (p) => (p === "src/auth.ts" ? "function login() {}" : null) }),
  );
  assert.equal(j.calls.length, 1);
  assert.equal(j.calls[0][4]?.currentFileContent, "function login() {}", "judge(spec, edit, defers, resolved, opts)");
});

test("readCurrentFile이 null(신규 파일·조회 실패)이면 opts.currentFileContent는 undefined", async () => {
  const j = spyJudge();
  await evaluateGate(makeInput(), makeDeps({ judge: j.fn, readCurrentFile: () => null }));
  assert.equal(j.calls[0][4]?.currentFileContent, undefined);
});

test("readCurrentFile은 doc-skip·cached 등 judge 미호출 경로에선 호출되지 않는다(불필요 I/O 방지)", async () => {
  let called = false;
  const readCurrentFile = () => {
    called = true;
    return null;
  };
  await evaluateGate(
    makeInput({ toolInput: { file_path: "README.md" } }),
    makeDeps({ readCurrentFile }),
  );
  assert.equal(called, false, "doc-skip은 judge 이전에 결정되므로 파일 읽기 불필요");
});

// ── fileBytes/truncated 계측(2026-08-07, 게이트 오탐 RCA 후속) ──
// judge에 실린 [현재 파일 상태] 원문 크기·8000바이트 절단 여부를 이벤트에 남긴다(경로·본문 없음).

test("fileBytes/truncated: 8000바이트 이하 파일은 truncated:false", async () => {
  const content = "x".repeat(100);
  const d = await evaluateGate(
    makeInput({ toolInput: { file_path: "src/small.ts", old_string: "a", new_string: "b" } }),
    makeDeps({ readCurrentFile: () => content }),
  );
  assert.equal(d.event.fileBytes, 100);
  assert.equal(d.event.truncated, false);
});

test("fileBytes/truncated: 8000바이트 초과 파일은 truncated:true — v18류 오탐의 재현 픽스처", async () => {
  const content = "x".repeat(12000);
  const d = await evaluateGate(
    makeInput({ toolInput: { file_path: "src/big.ts", old_string: "a", new_string: "b" } }),
    makeDeps({ readCurrentFile: () => content }),
  );
  assert.equal(d.event.fileBytes, 12000);
  assert.equal(d.event.truncated, true);
});

test("fileBytes/truncated: readCurrentFile null(신규 파일 등)이면 두 필드 다 이벤트에서 생략(undefined로 채우지 않음)", async () => {
  const d = await evaluateGate(makeInput(), makeDeps({ readCurrentFile: () => null }));
  assert.equal("fileBytes" in d.event, false);
  assert.equal("truncated" in d.event, false);
});

test("fileBytes: 멀티바이트(한글) 파일은 문자 길이가 아닌 실제 바이트 길이로 잰다", async () => {
  const content = "가".repeat(10); // UTF-8에서 한글 1자=3바이트 → 30바이트, 문자수(10)와 달라야 함
  const d = await evaluateGate(
    makeInput({ toolInput: { file_path: "src/kr.ts", old_string: "a", new_string: "b" } }),
    makeDeps({ readCurrentFile: () => content }),
  );
  assert.equal(d.event.fileBytes, 30);
  assert.notEqual(d.event.fileBytes, content.length, "문자 길이(10)와 바이트 길이(30)는 달라야 함");
});

test("fileBytes/truncated: block 이벤트에도 동일하게 첨부된다(pass 전용 아님)", async () => {
  const content = "x".repeat(9000);
  const d = await evaluateGate(
    makeInput({ toolInput: { file_path: "src/big.ts", old_string: "a", new_string: "b" } }),
    makeDeps({
      readCurrentFile: () => content,
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
    }),
  );
  assert.equal(d.kind, "block");
  assert.equal(d.event.fileBytes, 9000);
  assert.equal(d.event.truncated, true);
});

test("드리프트 가드: gate-core의 계측 임계값이 judge.ts의 실제 MAX_CURRENT_FILE과 값이 같다", async () => {
  const { MAX_CURRENT_FILE } = await import("../dist/judge.js");
  const { CURRENT_FILE_TRUNCATION_LIMIT } = await import("../dist/gate-core.js");
  assert.equal(
    CURRENT_FILE_TRUNCATION_LIMIT,
    MAX_CURRENT_FILE,
    "두 상수가 갈라지면 fileBytes/truncated 계측이 실제 절단 지점과 어긋난다 — 값을 동기화할 것",
  );
});

// ── readCurrentFile 보안 보강 (security-auditor 지적, 2026-07-14) ──
// PreToolUse는 편집이 *적용되기 전*에 실행된다 — file_path가 프로젝트 밖 임의 파일(예: 심링크로
// 위장된 ~/.ssh/id_rsa)을 가리켜도 이 함수가 그 내용을 읽어 judge 프롬프트(→외부 API)로 실어보내면
// 안 된다. spec.ts resolveSpecText와 동일 관례로 심링크 거부 + 병적 대용량 파일 스킵.

function tmpGateCoreDir() {
  return mkdtempSync(join(tmpdir(), "gbc-gate-core-security-"));
}

test("readCurrentFile: 일반 파일은 정상 읽는다", () => {
  const dir = tmpGateCoreDir();
  try {
    const file = join(dir, "a.ts");
    writeFileSync(file, "hello world");
    assert.equal(readCurrentFile(file), "hello world");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCurrentFile: 심링크는 거부(null) — 대상이 실제 파일이어도 임의 위치 읽기 차단", () => {
  const dir = tmpGateCoreDir();
  try {
    const real = join(dir, "secret.txt");
    writeFileSync(real, "민감정보");
    const link = join(dir, "decoy.ts");
    symlinkSync(real, link, "file");
    assert.equal(readCurrentFile(link), null, "심링크를 따라가 민감 파일을 읽으면 안 됨");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCurrentFile: 디렉토리 경로는 null(대상 아님)", () => {
  const dir = tmpGateCoreDir();
  try {
    const sub = join(dir, "subdir");
    mkdirSync(sub);
    assert.equal(readCurrentFile(sub), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCurrentFile: 존재하지 않는 파일은 null(신규 파일 — Write 대상)", () => {
  const dir = tmpGateCoreDir();
  try {
    assert.equal(readCurrentFile(join(dir, "nope.ts")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCurrentFile: 상한(1MB) 초과 파일은 null(hot path 동기 전체로드 방지)", () => {
  const dir = tmpGateCoreDir();
  try {
    const big = join(dir, "big.ts");
    writeFileSync(big, "x".repeat(1_000_001));
    assert.equal(readCurrentFile(big), null, "상한 초과는 스킵 — 정상 읽기와 구분");
    const small = join(dir, "small.ts");
    writeFileSync(small, "x".repeat(999_999));
    assert.notEqual(readCurrentFile(small), null, "상한 이내는 정상 읽힘(경계 케이스)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ── 0.9.3 ST2: 동일 missing 셋 재발화 억제 ──
// fa-support 도그푸딩 리포트: 순차 파이프라인에서 "형제 침묵 누락" 경고가 매 편집마다 반복 발화돼
// 노이즈였다. 같은 작업단위(specHash)에서 이미 pending-review에 기록된 missing 셋과 (정규화 후)
// 동일하면 두 번째부터는 block 대신 block-repeat(emit-direct, permission 없음=allow)로 강등한다.

test("block-repeat: 같은 specHash·같은(정규화 후) missing 셋 재발화는 block-repeat로 강등, permission 없음(허용)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 B 중복 이메일"], reason: "형제 누락" }),
      readPendingReview: () => ({
        missing: ["케이스 B 중복 이메일"],
        reason: "형제 누락",
        source: ".gbc/spec.md",
        at: "2026-07-13T00:00:00.000Z",
        specHash: DEFAULT_SPEC_HASH,
      }),
    }),
  );
  assert.equal(d.kind, "block-repeat");
  assert.equal(d.output.mode, "emit-direct");
  assert.equal(d.output.permission, undefined, "재발화는 승인 요청 없이 통과");
  assert.match(d.output.userMessage, /gbc gate review/, "gbc gate review로 안내");
});

test("block-repeat: 정규화 후 순서만 다른 missing 셋도 재발화로 인식(순서 무관)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({
        verdict: "block",
        missing: ["케이스 B 중복 이메일", "케이스 A 로그인 검증"],
        reason: "형제 누락",
      }),
      readPendingReview: () => ({
        missing: ["케이스 A 로그인 검증", "케이스 B 중복 이메일"],
        reason: "형제 누락",
        source: ".gbc/spec.md",
        at: "2026-07-13T00:00:00.000Z",
        specHash: DEFAULT_SPEC_HASH,
      }),
    }),
  );
  assert.equal(d.kind, "block-repeat");
});

test("block: pending 기록 없음(최초 발화)이면 여전히 정상 block", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 B 중복 이메일"], reason: "형제 누락" }),
      readPendingReview: () => null,
    }),
  );
  assert.equal(d.kind, "block");
  assert.equal(d.output.permission.decision, "ask");
});

test("block: missing 셋이 다르면(새 누락 추가) 재발화 아님 — 정상 block", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({
        verdict: "block",
        missing: ["케이스 B 중복 이메일", "케이스 C 신규"],
        reason: "형제 누락",
      }),
      readPendingReview: () => ({
        missing: ["케이스 B 중복 이메일"],
        reason: "형제 누락",
        source: ".gbc/spec.md",
        at: "2026-07-13T00:00:00.000Z",
        specHash: DEFAULT_SPEC_HASH,
      }),
    }),
  );
  assert.equal(d.kind, "block");
});

test("block: 같은 missing 셋이라도 specHash가 다르면(다른 작업단위) 재발화 아님 — 정상 block", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 B 중복 이메일"], reason: "형제 누락" }),
      readPendingReview: () => ({
        missing: ["케이스 B 중복 이메일"],
        reason: "형제 누락",
        source: ".gbc/spec.md",
        at: "2026-07-13T00:00:00.000Z",
        specHash: "다른작업단위해시",
      }),
    }),
  );
  assert.equal(d.kind, "block");
});

test("block-repeat: pendingReview 효과는 여전히 갱신된다(최신 사유·시각 보존)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 B 중복 이메일"], reason: "형제 누락(재확인)" }),
      readPendingReview: () => ({
        missing: ["케이스 B 중복 이메일"],
        reason: "형제 누락",
        source: ".gbc/spec.md",
        at: "2026-07-13T00:00:00.000Z",
        specHash: DEFAULT_SPEC_HASH,
      }),
    }),
  );
  assert.deepEqual(d.effects.pendingReview.missing, ["케이스 B 중복 이메일"]);
  assert.equal(d.effects.pendingReview.specHash, DEFAULT_SPEC_HASH);
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

// ── golden capture currentFileContent(2026-08-07, RCA 후속) ──
// cli.ts:627 replay가 currentFileContent를 안 넘겨 [현재 파일 상태] 섹션이 replay에선 항상 생략되던
// 것이 "골든 flip0"을 이 결함에 대해 무신호로 만든 기계적 원인이었다(braintrust 3렌즈 독립 합의).
// 캡처 시점에 필드를 남겨야 replay가 재현할 수 있다.

test("golden capture: readCurrentFile이 값을 반환하면 goldenCapture.currentFileContent에 그대로 담긴다", async () => {
  const d = await evaluateGate(
    makeInput({ toolInput: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } }),
    makeDeps({
      judge: async () => ({ verdict: "pass", missing: [], reason: "ok" }),
      isGoldenCapture: () => true,
      readCurrentFile: (p) => (p === "src/auth.ts" ? "function login() {}" : null),
    }),
  );
  assert.equal(d.effects.goldenCapture.currentFileContent, "function login() {}");
});

test("golden capture: readCurrentFile이 null(신규 파일 등)이면 currentFileContent 키 자체가 없다(undefined로 채우지 않음)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "pass", missing: [], reason: "ok" }),
      isGoldenCapture: () => true,
      readCurrentFile: () => null,
    }),
  );
  assert.equal("currentFileContent" in d.effects.goldenCapture, false);
});

// 0.12.3 P2a — SubTask3에서 계획했으나 누락됐던 골든 캡처 배선(발견 즉시 SubTask6에서 보정).
// appliedContext 없이 골든을 캡처하면 replay가 1차 판정에서조차 이 배치의 판정 로직 변경(P2a)에
// 무신호가 된다 — evidenceContext 누락이 낳았던 F-13(거짓 안심)의 재발 패턴과 동형.
test("golden capture: appliedContext가 있으면 goldenCapture.appliedContext에 그대로 담긴다", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "pass", missing: [], reason: "ok" }),
      isGoldenCapture: () => true,
      loadApplied: () => [{ at: "t1", tool: "Edit", file: "other.ts", digest: "적용본" }],
    }),
  );
  assert.match(d.effects.goldenCapture.appliedContext ?? "", /적용본/);
});

test("golden capture: 원장이 비었으면 appliedContext 키 자체가 없다(undefined로 채우지 않음, 다른 선택필드와 동일 관례)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "pass", missing: [], reason: "ok" }),
      isGoldenCapture: () => true,
    }),
  );
  assert.equal("appliedContext" in d.effects.goldenCapture, false);
});

// ── P2b 근거주입 2단계 재판정 (2026-08-07, 게이트 오탐 RCA ST12 — 이 배치의 유일한 판정 로직 변경) ──

test("근거주입: 매치 있는 케이스 전부가 재판정에서 해소되면 block→pass로 뒤집힌다(evidenceUsed·evidenceFlip=true)", async () => {
  const judgeCalls = [];
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => {
        judgeCalls.push(args);
        // 1차: block. 2차(evidenceContext 있음): pass.
        const opts = args[4];
        if (opts?.evidenceContext) return { verdict: "pass", missing: [], reason: "근거로 확인: 이미 구현됨" };
        return { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" };
      },
      collectCaseEvidence: async (cwd, missing) => missing.map((c) => ({ case: c, context: "src/auth.ts:10: function login() {}", matched: true })),
    }),
  );
  assert.equal(judgeCalls.length, 2, "1차 block + 2차 재판정 = judge 2회 호출");
  assert.equal(judgeCalls[1][4]?.evidenceContext, "케이스: 케이스 A 로그인 검증\nsrc/auth.ts:10: function login() {}");
  assert.equal(d.kind, "pass", "재판정이 전부 해소 → pass");
  assert.equal(d.event.evidenceUsed, true);
  assert.equal(d.event.evidenceFlip, true);
  // 0.12.1 P3 — 2단계 재판정도 1차와 동일하게 편집 앵커를 받아야 head 뒤쪽 윈도우가 살아있다.
  assert.deepEqual(judgeCalls[1][4]?.editOldStrings, ["a"], "재판정 호출도 1차와 동일한 editOldStrings를 받는다");
});

test("근거주입: 재판정이 missing 일부만 줄이면 block을 유지하되 missing이 축소된다", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => {
        const opts = args[4];
        if (opts?.evidenceContext) return { verdict: "block", missing: ["케이스 B 중복 이메일"], reason: "케이스 A는 확인됨, B는 여전히 누락" };
        return { verdict: "block", missing: ["케이스 A 로그인 검증", "케이스 B 중복 이메일"], reason: "누락 2건" };
      },
      collectCaseEvidence: async (cwd, missing) =>
        missing.map((c) => (c.includes("A") ? { case: c, context: "src/auth.ts:10: ok", matched: true } : { case: c, context: "", matched: false })),
    }),
  );
  assert.equal(d.kind, "block");
  assert.deepEqual(d.event.missing, ["케이스 B 중복 이메일"], "A는 해소, B만 남음");
  assert.equal(d.event.evidenceFlip, true, "missing 배열이 바뀌었으므로 flip");
});

test("근거주입: 매치가 0건이면 재판정 자체를 생략한다 — judge는 1회만 호출, 원래 block 유지", async () => {
  const judgeCalls = [];
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => {
        judgeCalls.push(args);
        return { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" };
      },
      collectCaseEvidence: async (cwd, missing) => missing.map((c) => ({ case: c, context: "", matched: false })),
    }),
  );
  assert.equal(judgeCalls.length, 1, "매치 없음 → 재판정 비용 지불 안 함");
  assert.equal(d.kind, "block");
  assert.equal(d.event.evidenceUsed, undefined, "재판정 자체가 없었으므로 evidenceUsed 키 생략");
});

test("근거주입: Write(전체 작성/덮어쓰기)는 근거수집 자체를 건너뛴다(★★ 규칙 충돌 방지 — 하드결정①)", async () => {
  let collectCalled = false;
  const judgeCalls = [];
  const d = await evaluateGate(
    makeInput({ toolName: "Write", toolInput: { file_path: "src/auth.ts", content: "전체 새 내용" } }),
    makeDeps({
      judge: async (...args) => {
        judgeCalls.push(args);
        return { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "덮어쓰기로 삭제되는 회귀" };
      },
      collectCaseEvidence: async (cwd, missing) => {
        collectCalled = true;
        return missing.map((c) => ({ case: c, context: "src/auth.ts:10: (구버전에 존재)", matched: true }));
      },
    }),
  );
  assert.equal(collectCalled, false, "Write는 근거수집(collectCaseEvidence) 자체를 호출하지 않는다");
  assert.equal(judgeCalls.length, 1, "재판정도 당연히 없음");
  assert.equal(d.kind, "block");
});

test("근거주입: 재판정이 fail-open이면 값검사로 폐기하고 원래 block을 유지한다(하드결정②, try/catch 아님)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => {
        const opts = args[4];
        if (opts?.evidenceContext) return { verdict: "pass", missing: [], reason: "네트워크 오류", failOpen: true };
        return { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" };
      },
      collectCaseEvidence: async (cwd, missing) => missing.map((c) => ({ case: c, context: "src/auth.ts:10: ok", matched: true })),
    }),
  );
  assert.equal(d.kind, "block", "재판정 fail-open은 폐기 — 정당한 block 자리에 조용히 pass가 앉으면 안 됨");
  assert.deepEqual(d.event.missing, ["케이스 A 로그인 검증"], "원래 missing 그대로");
  assert.equal(d.event.evidenceUsed, true, "재판정 시도 자체는 했다(발화)");
  assert.equal(d.event.evidenceFlip, false, "폐기됐으니 결과는 안 바뀜");
});

// ── F-9(0.12.0): 근거 총량 상한으로 잘린 케이스 수를 이벤트에 남긴다 ──
// evidenceBudgetExhausted(grep을 못 돌림)와 다른 축 — 이쪽은 grep은 돌았는데 결과가 프롬프트
// 예산에 못 들어간 경우다. 둘 다 0이어야 "근거를 다 보고 내린 판정"이라 말할 수 있다.

test("근거주입: 총량 상한으로 잘린 케이스가 있으면 evidenceDropped에 건수가 남는다", async () => {
  const huge = "x.ts:1: " + "가".repeat(3000);
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => {
        const opts = args[4];
        if (opts?.evidenceContext) return { verdict: "block", missing: ["케이스 0"], reason: "일부 해소" };
        return { verdict: "block", missing: Array.from({ length: 10 }, (_, i) => `케이스 ${i}`), reason: "누락 10건" };
      },
      collectCaseEvidence: async (cwd, missing) =>
        missing.map((c) => ({ case: c, context: huge, matched: true, budgetSkipped: false })),
    }),
  );
  assert.ok(d.event.evidenceDropped > 0, `잘린 건수가 기록되지 않음: ${d.event.evidenceDropped}`);
});

test("근거주입: 상한 이내면 evidenceDropped 키 자체를 생략한다", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => {
        const opts = args[4];
        if (opts?.evidenceContext) return { verdict: "pass", missing: [], reason: "해소" };
        return { verdict: "block", missing: ["케이스 A"], reason: "누락" };
      },
      collectCaseEvidence: async (cwd, missing) =>
        missing.map((c) => ({ case: c, context: "a.ts:1: impl", matched: true, budgetSkipped: false })),
    }),
  );
  assert.equal("evidenceDropped" in d.event, false);
});

// ── F-14(0.12.0): grep 예산 소진을 이벤트에 남긴다 ──
// 재판정 발화 여부(evidenceUsed)와 무관하게 기록해야 한다 — 매치 0으로 block을 유지한 판정이
// "근거가 없어서"인지 "예산이 모자라 못 봐서"인지가 바로 이 경우에 가장 알고 싶은 정보다.

test("근거주입: 예산 소진 케이스가 있으면 재판정이 없어도 evidenceBudgetExhausted=true", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
      collectCaseEvidence: async (cwd, missing) =>
        missing.map((c) => ({ case: c, context: "", matched: false, budgetSkipped: true })),
    }),
  );
  assert.equal(d.kind, "block");
  assert.equal(d.event.evidenceUsed, undefined, "매치 0이라 재판정은 없었다");
  assert.equal(d.event.evidenceBudgetExhausted, true, "그래도 '못 봤다'는 사실은 남아야 한다");
});

test("근거주입: 예산 소진이 없으면 evidenceBudgetExhausted 키 자체를 생략한다", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
      collectCaseEvidence: async (cwd, missing) =>
        missing.map((c) => ({ case: c, context: "", matched: false, budgetSkipped: false })),
    }),
  );
  assert.equal("evidenceBudgetExhausted" in d.event, false);
});

// ── F-3(0.12.0): evidenceFlip은 길이가 아니라 집합으로 판정해야 한다 ──
// 기존 식 `verdict2.missing.length !== verdict.missing.length`는 "개수는 같고 내용만 바뀐" 교체를
// flip=false로 기록한다. P2b가 오탐을 얼마나 해소했는지 증명해야 할 바로 그 지표가 과소집계된다.
// 같은 파일에 이미 `sameMissingSet`(정규화 후 집합비교)이 있으므로 그걸 재사용한다.

test("근거주입: 재판정이 같은 개수의 다른 케이스로 교체하면 evidenceFlip=true(길이 비교로는 놓친다)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => {
        const opts = args[4];
        if (opts?.evidenceContext) return { verdict: "block", missing: ["케이스 C 비밀번호 정책"], reason: "A는 확인됨, C가 새로 드러남" };
        return { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" };
      },
      collectCaseEvidence: async (cwd, missing) => missing.map((c) => ({ case: c, context: "src/auth.ts:10: ok", matched: true })),
    }),
  );
  assert.equal(d.kind, "block");
  assert.deepEqual(d.event.missing, ["케이스 C 비밀번호 정책"]);
  assert.equal(d.event.evidenceFlip, true, "내용이 바뀌었으면 개수가 같아도 flip이다");
});

test("근거주입: 재판정이 동일 집합을 순서만 바꿔 반환하면 evidenceFlip=false", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => {
        const opts = args[4];
        if (opts?.evidenceContext) return { verdict: "block", missing: ["케이스 B 중복 이메일", "케이스 A 로그인 검증"], reason: "동일" };
        return { verdict: "block", missing: ["케이스 A 로그인 검증", "케이스 B 중복 이메일"], reason: "누락 2건" };
      },
      collectCaseEvidence: async (cwd, missing) => missing.map((c) => ({ case: c, context: "src/auth.ts:10: ok", matched: true })),
    }),
  );
  assert.equal(d.event.evidenceFlip, false, "순서 차이는 flip이 아니다(sameMissingSet은 정규화 후 정렬 비교)");
});

test("근거주입: missing이 빈 배열(시나리오 미지정 block)이면 재판정 대상이 아니다", async () => {
  let collectCalled = false;
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: [], reason: "시나리오 미지정" }),
      collectCaseEvidence: async () => {
        collectCalled = true;
        return [];
      },
    }),
  );
  assert.equal(collectCalled, false);
  assert.equal(d.kind, "block");
});

// ── F-8(0.12.0): 이번 편집이 삭제하는 self-file 코드는 근거가 될 수 없다 ──
// Write는 위 "근거수집 자체를 건너뛴다" 테스트가 잠근다. Edit/MultiEdit은 억제 대상이 아니지만,
// 케이스 구현을 *지우는* 편집일 때 그 코드가 편집 전 파일에 아직 남아 있어 "이미 구현됨" 근거로
// 실린다 — 정답인 block을 근거로 pass 논증하는 경로. gate-core가 삭제 범위를 산출해 넘겨야 한다.

test("근거주입: Edit이 지우는 줄 범위가 collectCaseEvidence에 전달된다(F-8 배선)", async () => {
  const fileContent = ["const a = 1;", "function login() { /* 케이스 A */ }", "const b = 2;"].join("\n");
  let deletionArg;
  await evaluateGate(
    makeInput({
      toolInput: { file_path: "src/target.ts", old_string: "function login() { /* 케이스 A */ }", new_string: "" },
    }),
    makeDeps({
      readCurrentFile: () => fileContent,
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
      collectCaseEvidence: async (_cwd, missing, deletion) => {
        deletionArg = deletion;
        return missing.map((c) => ({ case: c, context: "", matched: false, budgetSkipped: false }));
      },
    }),
  );
  assert.ok(deletionArg, "삭제 범위가 전달돼야 함");
  assert.equal(deletionArg.file, join("/tmp/gate-core-test", "src/target.ts"), "키는 canonicalPath 기준 절대경로");
  assert.deepEqual([...deletionArg.lines], [2], "삭제되는 줄만 표시");
});

test("근거주입: 삭제형 Edit은 자기가 지울 코드를 근거로 못 써 block이 유지된다(F-8 실동작)", async () => {
  const fileContent = ["const a = 1;", "function login() { /* 케이스 A */ }", "const b = 2;"].join("\n");
  const judgeCalls = [];
  const d = await evaluateGate(
    makeInput({
      toolInput: { file_path: "src/target.ts", old_string: "function login() { /* 케이스 A */ }", new_string: "" },
    }),
    makeDeps({
      readCurrentFile: () => fileContent,
      judge: async (...args) => {
        judgeCalls.push(args);
        return { verdict: "block", missing: ["login 케이스 A 로그인 검증"], reason: "누락" };
      },
      // 실제 근거수집기를 fake grep으로 구동 — 배선이 아니라 결과까지 잠근다.
      collectCaseEvidence: (cwd, missing, deletion) =>
        realCollectCaseEvidence(cwd, missing, {
          deletion,
          grep: async () => "./src/target.ts:2: function login() { /* 케이스 A */ }",
        }),
    }),
  );
  assert.equal(judgeCalls.length, 1, "근거가 0이라 재판정 자체가 없어야 함");
  assert.equal(d.kind, "block");
  assert.equal(d.event.evidenceUsed, undefined, "삭제될 코드는 근거로 집계되지 않는다");
});

test("근거주입: 같은 파일이라도 삭제 범위 밖 기구현은 여전히 근거가 된다(과잉 억제 금지)", async () => {
  const fileContent = ["function login() { /* 케이스 A */ }", "const junk = 1;"].join("\n");
  const d = await evaluateGate(
    makeInput({
      toolInput: { file_path: "src/target.ts", old_string: "const junk = 1;", new_string: "" },
    }),
    makeDeps({
      readCurrentFile: () => fileContent,
      judge: async (...args) =>
        args[4]?.evidenceContext
          ? { verdict: "pass", missing: [], reason: "근거로 기구현 확인" }
          : { verdict: "block", missing: ["login 케이스 A 로그인 검증"], reason: "누락" },
      collectCaseEvidence: (cwd, missing, deletion) =>
        realCollectCaseEvidence(cwd, missing, {
          deletion,
          grep: async () => "./src/target.ts:1: function login() { /* 케이스 A */ }",
        }),
    }),
  );
  assert.equal(d.kind, "pass");
  assert.equal(d.event.evidenceUsed, true);
});

// ── F-10(0.12.0): 근거수집 실패가 정당한 block을 fail-open ALLOW로 바꾸면 안 된다 ──
// collectCaseEvidence는 grep 실행·경로 처리 등 I/O를 한다. 여기서 throw가 새면 evaluateGate 밖으로
// 올라가 runHookSafely가 "훅 자체 실패"로 흡수 → **편집 허용**이 된다. 즉 P2b(오탐 줄이려는 기능)의
// 실패가 게이트를 통째로 여는 경로다. judge 재판정 실패는 값검사(failOpen)로 이미 막혀 있으나,
// *수집 단계* 예외는 그 값검사 이전이라 별도 흡수가 필요하다.

test("근거주입: 근거수집이 throw해도 게이트는 원래 block을 유지한다(fail-open ALLOW 승격 차단)", async () => {
  const judgeCalls = [];
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => {
        judgeCalls.push(args);
        return { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" };
      },
      collectCaseEvidence: async () => {
        throw new Error("grep 실행 실패(ENOENT)");
      },
    }),
  );
  assert.equal(d.kind, "block", "수집 실패가 편집 허용으로 바뀌면 안 된다");
  assert.equal(judgeCalls.length, 1, "재판정은 시도조차 안 함");
  // 기본 block 모드는 "ask"(GBC_BLOCK_MODE=deny일 때만 deny) — 요점은 allow가 아니라는 것.
  assert.notEqual(d.output.permission.decision, "allow", "허가로 승격되면 안 된다");
});

test("근거주입: 수집 실패는 이벤트에 남는다 — P2b가 조용히 무력화된 상태를 '한 번도 안 돌았음'과 구분", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
      collectCaseEvidence: async () => {
        throw new Error("boom");
      },
    }),
  );
  assert.equal(d.event.evidenceFailed, true);
  assert.equal(d.event.evidenceUsed, undefined, "실패는 '근거주입 성공'으로 집계되지 않는다");
});

test("근거주입: 정상 경로엔 evidenceFailed 키가 붙지 않는다(다른 선택필드와 동일 관례)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
    }),
  );
  assert.equal(d.event.evidenceFailed, undefined);
});

// ── F-13(0.12.0): 골든 캡처가 P2b 2단계까지 남겨야 replay가 드리프트를 볼 수 있다 ──

test("골든 캡처: 근거주입 재판정이 돌면 근거 컨텍스트와 재판정 결과가 함께 캡처된다", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      isGoldenCapture: () => true,
      judge: async (...args) =>
        args[4]?.evidenceContext
          ? { verdict: "pass", missing: [], reason: "근거로 기구현 확인" }
          : { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" },
      collectCaseEvidence: async (_c, missing) =>
        missing.map((c) => ({ case: c, context: "src/auth.ts:10: function login() {}", matched: true, budgetSkipped: false })),
    }),
  );
  const g = d.effects.goldenCapture;
  assert.ok(g, "캡처가 있어야 함");
  assert.equal(g.expected.verdict, "block", "expected는 1차 판정 그대로(재판정으로 오염 금지)");
  assert.match(g.evidenceContext, /src\/auth\.ts:10/);
  assert.equal(g.expectedAfterEvidence.verdict, "pass");
  assert.deepEqual(g.expectedAfterEvidence.missing, []);
});

// 골든 저장 형태(0.12.0 ship 전 security-auditor 후속) — currentFileContent는 **디스크에 영속**되는
// 값인데 형제 필드 evidenceContext만 마스킹을 거치고 있었다. 그리고 골든셋엔 events.jsonl·
// extraction.jsonl과 달리 크기 상한도 로테이션도 없어 케이스마다 최대 1MB 원본이 무한 누적됐다.
test("골든 캡처: currentFileContent는 redactSecrets를 거쳐 저장된다(디스크 영속 = evidenceContext와 동일 기준)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      isGoldenCapture: () => true,
      readCurrentFile: () => 'const KEY = "sk-ant-abcdefghijklmnop";\nfunction login() {}',
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
    }),
  );
  const g = d.effects.goldenCapture;
  assert.ok(g, "캡처가 있어야 함");
  assert.ok(!g.currentFileContent.includes("sk-ant-abcdefghijklmnop"), "시크릿 원문이 남으면 안 됨");
  assert.match(g.currentFileContent, /function login/, "코드 본문은 보존 — 값만 마스킹");
});

// 0.12.1 P3 — 골든 저장 절단이 head-only 나이브 slice면 편집앵커 윈도우가 살린 절단면 뒤쪽 구간이
// 저장 시점에 다시 잘려나가 replay가 캡처 당시 judge가 실제로 본 것과 달라진다(F-13이 막으려던
// "거짓 안심"의 재발 — 이번엔 evidenceContext가 아니라 currentFileContent 저장 경로에서).
test("골든 캡처: currentFileContent 저장도 head+윈도우 절단을 반영한다(앵커 위치가 head 밖이어도 보존)", async () => {
  const { CURRENT_FILE_TRUNCATION_LIMIT } = await import("../dist/gate-core.js");
  const anchor = "SIBLING_MARKER_BEYOND_HEAD";
  // head(4000)를 한참 넘긴 위치에 앵커 배치 — 줄 단위(개행 포함)라 truncateCurrentFile이 정상 동작.
  const lines = Array.from({ length: 2000 }, (_, i) => (i === 1500 ? anchor : `line${i}`));
  const huge = lines.join("\n");
  const d = await evaluateGate(
    makeInput({ toolInput: { file_path: "src/foo.ts", old_string: anchor, new_string: anchor + "_x" } }),
    makeDeps({
      isGoldenCapture: () => true,
      readCurrentFile: () => huge,
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
    }),
  );
  const g = d.effects.goldenCapture;
  assert.ok(g, "캡처가 있어야 함");
  assert.ok(g.currentFileContent.length <= CURRENT_FILE_TRUNCATION_LIMIT, "여전히 예산 이내로 절단됨");
  assert.match(g.currentFileContent, /SIBLING_MARKER_BEYOND_HEAD/, "head 밖 앵커 근처가 저장분에도 보존돼야 replay가 캡처 당시와 동일해짐");
});

test("골든 캡처: currentFileContent는 CURRENT_FILE_TRUNCATION_LIMIT로 절단해 저장한다(그 뒤는 judge가 어차피 못 봄)", async () => {
  const { CURRENT_FILE_TRUNCATION_LIMIT } = await import("../dist/gate-core.js");
  const huge = "x".repeat(CURRENT_FILE_TRUNCATION_LIMIT * 3);
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      isGoldenCapture: () => true,
      readCurrentFile: () => huge,
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
    }),
  );
  const g = d.effects.goldenCapture;
  assert.ok(g, "캡처가 있어야 함");
  assert.ok(
    g.currentFileContent.length <= CURRENT_FILE_TRUNCATION_LIMIT,
    `골든 저장분이 상한을 넘음: ${g.currentFileContent.length} > ${CURRENT_FILE_TRUNCATION_LIMIT}`,
  );
});

test("골든 캡처: fileBytes/truncated 계측은 절단 *이전* 원본 크기를 그대로 반영한다(저장 절단과 별개 축)", async () => {
  const { CURRENT_FILE_TRUNCATION_LIMIT } = await import("../dist/gate-core.js");
  const huge = "x".repeat(CURRENT_FILE_TRUNCATION_LIMIT * 3);
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      isGoldenCapture: () => true,
      readCurrentFile: () => huge,
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
    }),
  );
  assert.equal(d.event.fileBytes, huge.length, "계측은 원본 크기 — 골든 저장 절단에 오염되면 안 됨");
  assert.equal(d.event.truncated, true);
});

test("골든 캡처: 재판정이 없으면 P2b 필드는 붙지 않는다(구버전 골든과 동일 모양)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      isGoldenCapture: () => true,
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
    }),
  );
  assert.equal(d.effects.goldenCapture.evidenceContext, undefined);
  assert.equal(d.effects.goldenCapture.expectedAfterEvidence, undefined);
});

test("골든 캡처: 재판정이 fail-open으로 폐기되면 P2b 필드도 남기지 않는다(신뢰 못 하는 기준 금지)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      isGoldenCapture: () => true,
      judge: async (...args) =>
        args[4]?.evidenceContext
          ? { verdict: "pass", missing: [], reason: "네트워크 오류", failOpen: true }
          : { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" },
      collectCaseEvidence: async (_c, missing) =>
        missing.map((c) => ({ case: c, context: "src/auth.ts:10: ok", matched: true, budgetSkipped: false })),
    }),
  );
  assert.equal(d.effects.goldenCapture.expectedAfterEvidence, undefined);
});

test("근거주입: 예산 소진 사유(개수/시간)가 이벤트까지 전달된다(scope-critic 지적 — 해소법이 다르다)", async () => {
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
      collectCaseEvidence: async (_c, missing) =>
        missing.map((c) => ({ case: c, context: "", matched: false, budgetSkipped: true, budgetSkipReason: "time" })),
    }),
  );
  assert.equal(d.event.evidenceBudgetExhausted, true);
  assert.equal(d.event.evidenceBudgetReason, "time");
});

// ── F-6(0.12.0): P2b 경계 분기 중 커버가 없던 2건 ──

test("근거주입: block이지만 missing이 비면 근거수집을 호출하지 않는다(수집할 케이스 자체가 없음)", async () => {
  let collectCalled = false;
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: [], reason: "시나리오 미지정" }),
      collectCaseEvidence: async () => {
        collectCalled = true;
        return [];
      },
    }),
  );
  assert.equal(collectCalled, false, "missing 0건이면 grep할 심볼이 없다");
  assert.equal(d.kind, "block");
});

test("근거주입: file_path가 없으면 삭제범위는 null로 넘어간다(근거수집 자체는 정상 수행)", async () => {
  let deletionArg = "unset";
  await evaluateGate(
    makeInput({ toolInput: { old_string: "a", new_string: "b" } }),
    makeDeps({
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
      collectCaseEvidence: async (_c, missing, deletion) => {
        deletionArg = deletion;
        return missing.map((c) => ({ case: c, context: "", matched: false, budgetSkipped: false }));
      },
    }),
  );
  assert.equal(deletionArg, null, "경로를 모르면 self-file 판별 자체가 불가능 — 억제 없이 진행");
});

test("근거주입: 파일을 읽지 못하면(신규·심링크·대용량) 삭제범위 없이 진행한다", async () => {
  let deletionArg = "unset";
  await evaluateGate(
    makeInput({ toolInput: { file_path: "src/target.ts", old_string: "a", new_string: "b" } }),
    makeDeps({
      readCurrentFile: () => null,
      judge: async () => ({ verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }),
      collectCaseEvidence: async (_c, missing, deletion) => {
        deletionArg = deletion;
        return missing.map((c) => ({ case: c, context: "", matched: false, budgetSkipped: false }));
      },
    }),
  );
  assert.equal(deletionArg, null);
});

test("근거주입: 2차 판정이 missing을 늘려도 그 결과를 채택하고 flip으로 기록한다(관대함 가정 금지)", async () => {
  // P2b는 "block을 pass로 바꾸는" 방향으로만 설계됐지만, 근거가 오히려 더 많은 누락을 드러낼 수도
  // 있다. 그 경우를 특례로 되돌리면 근거를 신뢰한다는 전제 자체가 무너진다 — 채택하고 계측한다.
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) =>
        args[4]?.evidenceContext
          ? { verdict: "block", missing: ["케이스 A 로그인 검증", "케이스 B 중복 이메일"], reason: "근거로 추가 누락 확인" }
          : { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" },
      collectCaseEvidence: async (_c, missing) =>
        missing.map((c) => ({ case: c, context: "src/auth.ts:10: ok", matched: true, budgetSkipped: false })),
    }),
  );
  assert.equal(d.kind, "block");
  assert.equal(d.event.evidenceUsed, true);
  assert.equal(d.event.evidenceFlip, true, "missing이 늘어난 것도 판정 변경이다");
  assert.deepEqual(d.event.missing, ["케이스 A 로그인 검증", "케이스 B 중복 이메일"]);
});

// ── 0.12.3 P2a — 작업단위 적용이력 배선(이 배치의 유일한 판정 로직 변경) ──
// 캐시분기(④) 이후·judge 호출(⑤) 직전에 applied.ts의 원장을 읽어 [이 작업단위에서 이미 적용된
// 편집] 섹션을 조립한다. 1차 judge와 P2b 2차 재판정 양쪽에 전달, 읽기 실패는 fail-open([]로
// 흡수, 게이트를 더 엄격하게 만들지 않는다), Write는 self-file 엔트리를 제외한다(GATE_SYSTEM ★★
// 규칙 대칭 — evidence.ts의 F-8/Write 억제와 같은 계열).

test("applied: loadApplied가 logHash(빈 명세는 '')로 호출된다 — specHash 상수 오염 재방지", async () => {
  const calls = [];
  await evaluateGate(makeInput(), makeDeps({ loadApplied: (cwd, specHash) => { calls.push([cwd, specHash]); return []; } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], DEFAULT_SPEC_HASH);
});

test("applied: 빈 명세는 loadApplied에 ''로 호출된다(원장 조회 자체를 empty sentinel로 방어)", async () => {
  const calls = [];
  await evaluateGate(
    makeInput(),
    makeDeps({
      loadPlanSpec: () => ({ text: "", source: ".gbc/spec.md" }),
      loadApplied: (cwd, specHash) => { calls.push(specHash); return []; },
    }),
  );
  assert.deepEqual(calls, [""]);
});

test("applied: 원장에 엔트리가 있으면 1차 judge 호출의 appliedContext에 실린다", async () => {
  const judgeCalls = [];
  await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => { judgeCalls.push(args); return { verdict: "pass", missing: [], reason: "ok" }; },
      loadApplied: () => [{ at: "t1", tool: "Edit", file: "other.ts", digest: "이미 구현된 내용" }],
    }),
  );
  assert.match(judgeCalls[0][4]?.appliedContext ?? "", /other\.ts/);
  assert.match(judgeCalls[0][4]?.appliedContext ?? "", /이미 구현된 내용/);
});

test("applied: 원장이 비어있으면 appliedContext는 undefined(플레이스홀더 오염 방지 — evidenceContext와 동일 관례)", async () => {
  const judgeCalls = [];
  await evaluateGate(makeInput(), makeDeps({ judge: async (...args) => { judgeCalls.push(args); return { verdict: "pass", missing: [], reason: "ok" }; } }));
  assert.equal(judgeCalls[0][4]?.appliedContext, undefined);
});

test("applied: P2b 2차 재판정 호출에도 동일한 appliedContext가 실린다", async () => {
  const judgeCalls = [];
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => {
        judgeCalls.push(args);
        const opts = args[4];
        if (opts?.evidenceContext) return { verdict: "pass", missing: [], reason: "근거로 확인" };
        return { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" };
      },
      collectCaseEvidence: async (cwd, missing) => missing.map((c) => ({ case: c, context: "src/auth.ts:10: ok", matched: true })),
      loadApplied: () => [{ at: "t1", tool: "Edit", file: "other.ts", digest: "적용본" }],
    }),
  );
  assert.equal(judgeCalls.length, 2);
  assert.match(judgeCalls[0][4]?.appliedContext ?? "", /적용본/, "1차에도 실림");
  assert.match(judgeCalls[1][4]?.appliedContext ?? "", /적용본/, "2차 재판정에도 동일하게 실림");
  assert.equal(d.kind, "pass");
});

test("applied: Write(전체 덮어쓰기)는 같은 파일의 과거 엔트리를 제외한다(GATE_SYSTEM ★★ 대칭)", async () => {
  const judgeCalls = [];
  await evaluateGate(
    makeInput({ toolName: "Write", toolInput: { file_path: "src/foo.ts", content: "new body" } }),
    makeDeps({
      judge: async (...args) => { judgeCalls.push(args); return { verdict: "pass", missing: [], reason: "ok" }; },
      loadApplied: () => [
        { at: "t1", tool: "Edit", file: "foo.ts", digest: "자기파일 과거편집" },
        { at: "t2", tool: "Edit", file: "bar.ts", digest: "다른파일 편집" },
      ],
    }),
  );
  const ctx = judgeCalls[0][4]?.appliedContext ?? "";
  assert.doesNotMatch(ctx, /자기파일 과거편집/, "덮어쓰기 대상 파일 자신의 과거 엔트리는 빠져야 함");
  assert.match(ctx, /다른파일 편집/, "다른 파일 엔트리는 유지");
});

test("applied: Edit(부분 편집)은 자기 파일의 과거 엔트리도 유지한다(Write와 달리 self-file 필터 없음)", async () => {
  const judgeCalls = [];
  await evaluateGate(
    makeInput({ toolInput: { file_path: "src/foo.ts", old_string: "a", new_string: "b" } }),
    makeDeps({
      judge: async (...args) => { judgeCalls.push(args); return { verdict: "pass", missing: [], reason: "ok" }; },
      loadApplied: () => [{ at: "t1", tool: "Edit", file: "foo.ts", digest: "이전 편집" }],
    }),
  );
  assert.match(judgeCalls[0][4]?.appliedContext ?? "", /이전 편집/);
});

test("applied: loadApplied가 throw해도 게이트는 계속 진행한다(fail-open — 새 메커니즘 실패가 게이트를 더 엄격하게 만들지 않음)", async () => {
  const judgeCalls = [];
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => { judgeCalls.push(args); return { verdict: "pass", missing: [], reason: "ok" }; },
      loadApplied: () => { throw new Error("disk read failure"); },
    }),
  );
  assert.equal(judgeCalls.length, 1, "원장 읽기 실패가 judge 호출 자체를 막지 않는다");
  assert.equal(judgeCalls[0][4]?.appliedContext, undefined);
  assert.equal(d.kind, "pass");
  assert.equal(d.event.appliedFailed, true, "실패가 조용히 사라지지 않고 이벤트에 남는다");
});

test("applied: 정상 케이스는 이벤트에 appliedFailed 키 자체가 없다(다른 계측 필드와 동일 관례)", async () => {
  const d = await evaluateGate(makeInput(), makeDeps({ loadApplied: () => [{ at: "t1", tool: "Edit", file: "other.ts", digest: "x" }] }));
  assert.equal(d.event.appliedFailed, undefined);
  assert.equal(d.event.appliedCount, 1);
});

test("applied: appliedCount는 judge에 실제로 실린 엔트리 수(원장 엔트리 없으면 키 생략)", async () => {
  const d = await evaluateGate(makeInput(), makeDeps());
  assert.equal(d.event.appliedCount, undefined);
});

// ── 0.12.4 ST3 — 원장 생존 재검증 배선(security-auditor Critical 본체) ──
// 원장 조회(loadApplied) 직후·selectAppliedForJudge 직전에 각 엔트리를 재검증한다. 다른 파일
// 엔트리는 deps.readCurrentFile(join(cwd, entry.file))로 읽고, 편집 대상 파일과 같은 엔트리는
// 이미 읽은 currentFileContent를 재사용한다(재판독 금지).

test("applied: 다른 파일의 기적용 코드가 이후 삭제됐으면(stale) judge 입력에서 빠진다", async () => {
  const judgeCalls = [];
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => { judgeCalls.push(args); return { verdict: "block", missing: ["케이스 A 로그인 검증"], reason: "누락" }; },
      loadApplied: () => [{ at: "t1", tool: "Edit", file: "other.ts", digest: "function impl() { return 1; }" }],
      readCurrentFile: (p) => (p.endsWith("other.ts") ? "// impl은 리팩토링으로 사라짐\nfunction other() {}" : null),
    }),
  );
  assert.equal(judgeCalls[0][4]?.appliedContext, undefined, "stale 엔트리만 있었으므로 섹션 자체가 생략된다");
  assert.equal(d.event.appliedStale, 1);
  assert.equal(d.event.appliedCount, undefined, "judge에 실린 게 없으므로 appliedCount도 생략");
});

test("applied: 원장 코드가 여전히 파일에 있으면(alive) 그대로 유지된다", async () => {
  const judgeCalls = [];
  await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => { judgeCalls.push(args); return { verdict: "pass", missing: [], reason: "ok" }; },
      loadApplied: () => [{ at: "t1", tool: "Edit", file: "other.ts", digest: "function impl() { return 1; }" }],
      readCurrentFile: (p) => (p.endsWith("other.ts") ? "// 위\nfunction impl() { return 1; }\n// 아래" : null),
    }),
  );
  assert.match(judgeCalls[0][4]?.appliedContext ?? "", /function impl/);
});

test("applied: 읽기 실패(unverifiable)는 stale로 단정하지 않고 유지한다", async () => {
  const judgeCalls = [];
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => { judgeCalls.push(args); return { verdict: "pass", missing: [], reason: "ok" }; },
      loadApplied: () => [{ at: "t1", tool: "Edit", file: "other.ts", digest: "function impl() {}" }],
      readCurrentFile: () => null, // 읽기 실패 흉내
    }),
  );
  assert.match(judgeCalls[0][4]?.appliedContext ?? "", /function impl/, "unverifiable은 버리지 않는다");
  assert.equal(d.event.appliedUnverified, 1);
  assert.equal(d.event.appliedStale, undefined);
});

test("applied: 편집 대상과 같은 파일 엔트리는 currentFileContent를 재사용한다(재판독 안 함)", async () => {
  const readCalls = [];
  const readCurrentFile = (p) => { readCalls.push(p); return "function impl() {}"; };
  await evaluateGate(
    makeInput({ toolInput: { file_path: "src/foo.ts", old_string: "a", new_string: "b" } }),
    makeDeps({
      loadApplied: () => [{ at: "t1", tool: "Edit", file: "foo.ts", digest: "function impl() {}" }],
      readCurrentFile,
    }),
  );
  assert.equal(readCalls.length, 1, "편집 대상 파일 읽기(judge용) 1회뿐 — 재검증이 같은 파일을 다시 읽으면 안 된다");
});

test("applied: 같은 파일을 가리키는 여러 엔트리는 파일을 1번만 읽는다(dedupe)", async () => {
  const readCalls = [];
  const readCurrentFile = (p) => { readCalls.push(p); return "function a() {}\nfunction b() {}"; };
  await evaluateGate(
    makeInput(),
    makeDeps({
      loadApplied: () => [
        { at: "t1", tool: "Edit", file: "other.ts", digest: "function a() {}" },
        { at: "t2", tool: "Edit", file: "other.ts", digest: "function b() {}" },
      ],
      readCurrentFile,
    }),
  );
  const otherReads = readCalls.filter((p) => p.endsWith("other.ts"));
  assert.equal(otherReads.length, 1, "같은 파일은 캐시로 1번만 읽어야 한다");
});

test("applied: outside 엔트리는 재검증 시 파일을 읽지 않고(잘못된 경로 방지) unverifiable로 유지한다", async () => {
  const readCalls = [];
  const judgeCalls = [];
  const d = await evaluateGate(
    makeInput(),
    makeDeps({
      judge: async (...args) => { judgeCalls.push(args); return { verdict: "pass", missing: [], reason: "ok" }; },
      loadApplied: () => [{ at: "t1", tool: "Edit", file: "passwd", digest: "function impl() {}", outside: true }],
      readCurrentFile: (p) => { readCalls.push(p); return "function impl() {}"; },
    }),
  );
  // readCalls엔 편집 대상 파일(src/foo.ts, judge용 기존 읽기) 1건은 포함된다 — outside 엔트리
  // 재검증만 국한해서 검사한다: join(cwd, "passwd")로 엉뚱한 파일을 읽으면 안 된다.
  assert.ok(!readCalls.some((p) => p.endsWith("passwd")), "outside 엔트리는 join(cwd, basename)으로 읽으면 안 된다");
  assert.match(judgeCalls[0][4]?.appliedContext ?? "", /function impl/, "unverifiable은 유지된다");
  assert.equal(d.event.appliedUnverified, 1);
});

test("applied: appliedStale/appliedUnverified는 0이면 이벤트에 키 자체가 없다(다른 계측 필드와 동일 관례)", async () => {
  const d = await evaluateGate(makeInput(), makeDeps({ loadApplied: () => [{ at: "t1", tool: "Edit", file: "other.ts", digest: "x" }] }));
  assert.equal(d.event.appliedStale, undefined);
  assert.equal(d.event.appliedUnverified, 1, "기본 readCurrentFile fake는 null 반환 → unverifiable");
});
