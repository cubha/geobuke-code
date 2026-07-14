// gate-core evaluateGate 분기별 GateDecision 단정 (0.7.0 A1 ST1).
// 이 테스트가 preToolUseBody 오케스트레이션 추출의 *실제 회귀락*이다 — 골든replay는 judge()만,
// 248 단위는 순수 export 헬퍼만 커버해 이 분기 로직엔 커버가 0이었다(advisor 지적, 실측 확인).
// 모델·디스크 없이 결정론 검증: judge/loadPlanSpec/isGated 등을 fake로 주입한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, readCurrentFile } from "../dist/gate-core.js";
import { computeSpecHash } from "../dist/spec.js";
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

test("judge 호출 시 readCurrentFile(file_path) 결과를 5번째 인자로 전달", async () => {
  const j = spyJudge();
  await evaluateGate(
    makeInput({ toolInput: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } }),
    makeDeps({ judge: j.fn, readCurrentFile: (p) => (p === "src/auth.ts" ? "function login() {}" : null) }),
  );
  assert.equal(j.calls.length, 1);
  assert.equal(j.calls[0][4], "function login() {}", "judge(spec, edit, defers, resolved, currentFileContent)");
});

test("readCurrentFile이 null(신규 파일·조회 실패)이면 judge 5번째 인자는 undefined", async () => {
  const j = spyJudge();
  await evaluateGate(makeInput(), makeDeps({ judge: j.fn, readCurrentFile: () => null }));
  assert.equal(j.calls[0][4], undefined);
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
