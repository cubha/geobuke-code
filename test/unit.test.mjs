import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { normalizeEdit, isGatedTool } from "../dist/normalize.js";
import { parseVerdict, buildUserMessage, failOpenVerdict, GATE_SYSTEM } from "../dist/judge.js";
import { parseReviewVerdict, judgeReviewed, buildReviewMessage } from "../dist/judge.js";
import { computeSpecHash, loadPlanSpec } from "../dist/spec.js";
import {
  addDefer,
  activeDeferItems,
  resolvedDeferItems,
  resolveDefer,
  unresolvedDefers,
  loadDefers,
  startDefer,
  reopenDefer,
} from "../dist/defer.js";
import { isGated, markGated, resetGate, loadState } from "../dist/state.js";
import { addSpecCase, readSpecCases, clearSpec, archiveSpec, pruneSpecArchive } from "../dist/spec.js";
import {
  buildBlockReason,
  shouldCacheVerdict,
  buildSessionStartHint,
  buildStopReminder,
  buildCrossRepoHint,
  buildSessionStartPayload,
  formatScopeFindings,
  logScopeVerdicts,
} from "../dist/hook.js";
import { loadRepos, addRepo, removeRepo } from "../dist/repos.js";
import {
  selectCases,
  resolveRefs,
  writePendingReview,
  readPendingReview,
  clearPendingReview,
} from "../dist/review.js";
import {
  buildPreCommand,
  normalizeHooks,
  buildSessionStartCommand,
  ensureSessionStartHook,
  hasStalePreToolUse,
  hasSessionStartHook,
  hasPreToolUseGate,
  assessRepoHealth,
  DEV_PLACEHOLDER,
} from "../dist/install.js";
import {
  buildInitStalenessNotice,
  wasNotified,
  markNotified,
  buildUpdateNotice,
} from "../dist/notice.js";
import {
  compareVersions,
  buildVersionNotice,
  isCacheStale,
  readVersionCache,
  isValidVersion,
  writeVersionCache,
  shouldRefreshCache,
} from "../dist/version.js";
import { serializeEvent, parseEvents, computeMetrics, logEvent, tagEventsWithRepo } from "../dist/metrics.js";
import { goldenCaseId, diffVerdict, upsertGolden, summarizeReplay } from "../dist/golden.js";
import { resolveApiKey, safeModel, buildCliInvocation } from "../dist/judge.js";
import { normalizeCase, MAX_CASE } from "../dist/text.js";
import { isStopHintMuted, setStopHintMuted } from "../dist/config.js";
import { parseBinding } from "../dist/verify.js";
import {
  enqueueScope,
  readScopeQueue,
  clearScopeQueue,
  parseGrepOutput,
  formatGrepContext,
  extractSymbols,
  collectGrepContext,
  MAX_SCOPE_QUEUE,
  MAX_GREP_MATCHES,
  MAX_GREP_LINE_LEN,
  MAX_SCOPE_CONTEXT_CHARS,
  MAX_GREP_SYMBOLS,
} from "../dist/scope.js";
import {
  buildScopeMessage,
  parseScopeVerdicts,
  judgeScope,
  SCOPE_SYSTEM,
  SCOPE_MODEL,
} from "../dist/judge.js";
import { parseJUnit, readVerifyResults, JUNIT_DEFAULT_REL } from "../dist/junit.js";
import { runVerify } from "../dist/verify.js";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

test("buildUserMessage: resolved 항목이 [이미 완료된 항목] 블록에 나열 (ST1)", () => {
  const m = buildUserMessage("plan", "edit", ["미룸X"], ["완료된케이스Y"]);
  assert.match(m, /\[이미 완료된 항목\]/);
  assert.match(m, /- 완료된케이스Y/);
  // 미룸과 완료가 다른 블록에 분리돼야 한다(judge가 둘을 구분)
  assert.match(m, /- 미룸X/);
});

test("buildUserMessage: resolved 없으면 [이미 완료된 항목] 블록도 (없음) (ST1)", () => {
  const m = buildUserMessage("plan", "edit", [], []);
  assert.match(m, /\[이미 완료된 항목\]\n\(없음\)/);
});

test("buildUserMessage: resolved 인자 생략 시 하위호환(블록은 있되 없음) (ST1)", () => {
  const m = buildUserMessage("plan", "edit", []);
  assert.match(m, /\[이미 완료된 항목\]/);
});

test("resolvedDeferItems: status=resolved만 반환 (ST1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-resolved-"));
  try {
    addDefer(dir, "A 완료대상");
    addDefer(dir, "B 미해결");
    resolveDefer(dir, "1"); // A만 resolve
    assert.deepEqual(resolvedDeferItems(dir), ["A 완료대상"]);
    // active(미해결)와 상호배타: B만 active
    assert.deepEqual(activeDeferItems(dir), ["B 미해결"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GATE_SYSTEM: 이미 완료된 항목 제외 규칙 포함 (ST1)", () => {
  assert.match(GATE_SYSTEM, /이미 완료된 항목/);
});

test("computeSpecHash: 동일 입력 동일 해시, 변경 시 다른 해시", () => {
  assert.equal(computeSpecHash("abc"), computeSpecHash("abc"));
  assert.notEqual(computeSpecHash("abc"), computeSpecHash("abd"));
});

test("loadPlanSpec: scratch.md는 명세 소스에서 제외 (0.2.2 단일정본화)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-spec-src-"));
  try {
    // scratch.md만 있어도 명세로 안 읽음 → 빈 텍스트 + source "(없음)"
    writeFileSync(join(dir, "scratch.md"), "# 진행현황\n- 작업중", "utf8");
    const r1 = loadPlanSpec(dir);
    assert.equal(r1.text, "");
    assert.match(r1.source, /없음/);

    // .gbc/spec.md가 정본
    mkdirSync(join(dir, ".gbc"), { recursive: true });
    writeFileSync(join(dir, ".gbc", "spec.md"), "케이스 A", "utf8");
    const r2 = loadPlanSpec(dir);
    assert.equal(r2.text, "케이스 A");
    assert.match(r2.source, /spec\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlanSpec: GBC_SPEC_FILE가 .gbc/spec.md보다 우선 (0.2.2 명시 override = 유일 마이그레이션 경로)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-spec-env-"));
  const override = join(dir, "my-plan.md");
  const prev = process.env.GBC_SPEC_FILE;
  try {
    mkdirSync(join(dir, ".gbc"), { recursive: true });
    writeFileSync(join(dir, ".gbc", "spec.md"), "정본 케이스", "utf8");
    writeFileSync(override, "override 케이스", "utf8");
    process.env.GBC_SPEC_FILE = override;
    const r = loadPlanSpec(dir);
    assert.equal(r.text, "override 케이스"); // env override가 .gbc/spec.md를 이긴다
    assert.equal(r.source, override);
  } finally {
    if (prev === undefined) delete process.env.GBC_SPEC_FILE;
    else process.env.GBC_SPEC_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlanSpec: GBC_SPEC_FILE 상대경로는 cwd 기준으로 해석 (W1, hook 프로세스 cwd 아님)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-spec-rel-"));
  const prev = process.env.GBC_SPEC_FILE;
  try {
    // 상대 파일명을 dir 안에 둔다. 테스트 프로세스의 cwd는 프로젝트 루트라 dir과 다르다.
    writeFileSync(join(dir, "rel-plan.md"), "상대 케이스", "utf8");
    process.env.GBC_SPEC_FILE = "rel-plan.md"; // 상대경로
    const r = loadPlanSpec(dir);
    assert.equal(r.text, "상대 케이스"); // process.cwd가 아닌 인자 cwd(dir) 기준 해석
  } finally {
    if (prev === undefined) delete process.env.GBC_SPEC_FILE;
    else process.env.GBC_SPEC_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlanSpec: cwd 밖 절대경로 GBC_SPEC_FILE은 차단 아닌 경고만(escape-hatch 보존, W1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-spec-out-"));
  const outside = mkdtempSync(join(tmpdir(), "gbc-shared-"));
  const shared = join(outside, "shared-plan.md");
  const prev = process.env.GBC_SPEC_FILE;
  try {
    writeFileSync(shared, "공유 명세", "utf8");
    process.env.GBC_SPEC_FILE = shared; // cwd 밖 절대경로 — 정당한 명시 지정
    const r = loadPlanSpec(dir);
    assert.equal(r.text, "공유 명세"); // 막지 않고 그대로 읽는다(경고만)
    assert.equal(r.source, resolve(dir, shared));
  } finally {
    if (prev === undefined) delete process.env.GBC_SPEC_FILE;
    else process.env.GBC_SPEC_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("defer-registry: add → active → resolve 흐름", () => {
  const dir = tmp();
  try {
    addDefer(dir, "비밀번호 8자 검증");
    addDefer(dir, "중복 이메일 차단");
    assert.deepEqual(activeDeferItems(dir).sort(), ["비밀번호 8자 검증", "중복 이메일 차단"].sort());
    // 텍스트 부분 매칭 해결 (resolveDefer는 0.2.5부터 전환된 엔트리 배열 반환)
    const r = resolveDefer(dir, "비밀번호");
    assert.equal(r.length, 1);
    assert.equal(activeDeferItems(dir).length, 1);
    assert.equal(unresolvedDefers(dir).length, 1);
    // 인덱스 해결
    resolveDefer(dir, "2");
    assert.equal(activeDeferItems(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defer 마이그레이션: 옛 {resolved:bool} → status 자동 승격 + 라운드트립 (ST1, 0.2.5)", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, ".gbc"), { recursive: true });
    // 옛 포맷(0.2.4 이하) 직접 기록 — 실데이터 픽스처
    const old = [
      { item: "A 해결됨", at: "t1", resolved: true },
      { item: "B 미해결", at: "t2", resolved: false },
      { item: "C 필드없음", at: "t3" }, // resolved 부재 → open 취급
    ];
    writeFileSync(join(dir, ".gbc", "defers.json"), JSON.stringify(old));

    // 읽을 때 status로 자동 승격
    const loaded = loadDefers(dir);
    assert.equal(loaded[0].status, "resolved", "resolved:true → status:resolved");
    assert.equal(loaded[1].status, "open", "resolved:false → status:open");
    assert.equal(loaded[2].status, "open", "resolved 부재 → status:open");
    // activeDeferItems = open + in_progress (gate-neutral): A 제외, B·C 포함
    assert.deepEqual(activeDeferItems(dir).sort(), ["B 미해결", "C 필드없음"].sort());

    // 라운드트립: 쓰기가 일어나면 디스크는 status로 통일되고 옛 resolved 필드는 사라진다
    resolveDefer(dir, "2"); // B 해결
    const raw = JSON.parse(readFileSync(join(dir, ".gbc", "defers.json"), "utf8"));
    assert.ok(raw.every((e) => typeof e.status === "string"), "저장은 status로 통일");
    assert.ok(raw.every((e) => !("resolved" in e)), "옛 resolved 필드는 제거(단일 소스)");
    assert.equal(raw.find((e) => e.item === "B 미해결").status, "resolved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defer 전환: start/resolve/reopen — 인덱스·텍스트·복수·all + 전환별 적격 (ST2, 0.2.5)", () => {
  const dir = tmp();
  try {
    addDefer(dir, "A 항목");
    addDefer(dir, "B 항목");
    addDefer(dir, "C 항목");

    // start: 텍스트 부분매칭, open → in_progress
    const s = startDefer(dir, "A");
    assert.equal(s.length, 1);
    assert.equal(loadDefers(dir)[0].status, "in_progress");
    // gate-neutral: in_progress도 judge 입력엔 '미해결'로 포함
    assert.equal(activeDeferItems(dir).length, 3);

    // resolve 복수 인덱스 "2 3" → B,C resolved
    const r = resolveDefer(dir, "2 3");
    assert.equal(r.length, 2);
    assert.equal(activeDeferItems(dir).length, 1); // A(in_progress)만 미해결

    // reopen all: 적격 = resolved + in_progress 전부 → open
    const re = reopenDefer(dir, "all");
    assert.equal(re.length, 3);
    assert.ok(loadDefers(dir).every((d) => d.status === "open"));

    // resolve all: 적격 = open + in_progress 전부
    const ra = resolveDefer(dir, "all");
    assert.equal(ra.length, 3);
    assert.equal(activeDeferItems(dir).length, 0);

    // start all: 적격 = open만 (지금 전부 resolved) → 0건
    assert.equal(startDefer(dir, "all").length, 0);

    // 빈 ref 가드(S3-1): includes("")가 첫 항목을 매칭하지 않도록 0건 반환
    reopenDefer(dir, "all"); // 전부 open으로 복구
    assert.equal(startDefer(dir, "").length, 0);
    assert.equal(startDefer(dir, "   ").length, 0);
    assert.ok(loadDefers(dir).every((d) => d.status === "open")); // 빈 ref가 아무것도 전환 안 함
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gbc defer CLI: start/resolve/reopen + list 3상태 표시 (ST3, 0.2.5)", () => {
  const proj = tmp();
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const run = (...a) =>
    execFileSync(process.execPath, [cli, "defer", ...a], {
      cwd: proj,
      env: { ...process.env },
      encoding: "utf8",
    });
  try {
    run("add", "케이스 하나");
    run("add", "케이스 둘");

    // start 1 → in_progress, list가 [진행중] 구분 표시
    run("start", "1");
    let out = run("list");
    assert.match(out, /1\. \[진행중\] 케이스 하나/);
    assert.match(out, /2\. \[미해결\] 케이스 둘/);

    // resolve all → 전환 건수 표면화
    const r = run("resolve", "all");
    assert.match(r, /2건/, "전환된 건수를 표면화해야 한다");
    out = run("list");
    assert.match(out, /1\. \[해결\] 케이스 하나/);
    assert.match(out, /2\. \[해결\] 케이스 둘/);

    // reopen 1 → 다시 open
    run("reopen", "1");
    out = run("list");
    assert.match(out, /1\. \[미해결\] 케이스 하나/);

    // 매칭 0건이면 안내
    const none = run("resolve", "존재안함텍스트");
    assert.match(none, /없음|0건/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("config: isStopHintMuted 기본 false, setStopHintMuted 영속 토글 (defer mute)", () => {
  const dir = tmp();
  try {
    assert.equal(isStopHintMuted(dir), false); // 파일/키 부재 → 노출(기본)
    setStopHintMuted(dir, true);
    assert.equal(isStopHintMuted(dir), true);
    setStopHintMuted(dir, false);
    assert.equal(isStopHintMuted(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gbc defer mute/unmute CLI: 토글 + list 상태표기 + 발견성 출력", () => {
  const proj = tmp();
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const run = (...a) =>
    execFileSync(process.execPath, [cli, "defer", ...a], {
      cwd: proj,
      env: { ...process.env },
      encoding: "utf8",
    });
  try {
    run("add", "케이스 하나");
    // mute → 발견성 안내(SessionStart 유지·unmute 경로) + 영속 저장
    const m = run("mute");
    assert.match(m, /음소거/);
    assert.match(m, /unmute/);
    assert.equal(isStopHintMuted(proj), true);
    // list가 음소거 상태를 표기
    assert.match(run("list"), /음소거 중/);
    // unmute → 복원
    const u = run("unmute");
    assert.match(u, /해제/);
    assert.equal(isStopHintMuted(proj), false);
    assert.doesNotMatch(run("list"), /음소거 중/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("runStop 가드: mute 시 미해결 defer 있어도 Stop hook 무출력(침묵)", () => {
  const proj = tmp();
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const stopInput = JSON.stringify({ cwd: proj, stop_hook_active: false });
  const runStop = () =>
    execFileSync(process.execPath, [cli, "hook", "stop"], {
      cwd: proj,
      env: { ...process.env },
      input: stopInput,
      encoding: "utf8",
    });
  try {
    execFileSync(process.execPath, [cli, "defer", "add", "남은 작업"], {
      cwd: proj,
      env: { ...process.env },
      encoding: "utf8",
    });
    // mute 전: Stop이 리마인드를 emit(block JSON)
    assert.match(runStop(), /미해결 defer/);
    // mute 후: 완전 침묵(빈 출력)
    setStopHintMuted(proj, true);
    assert.equal(runStop().trim(), "");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("SessionStart 상태줄: muted + 미해결 defer면 음소거 환기 1줄, 잔여 0이면 무음", () => {
  const proj = tmp();
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const env = { ...process.env, GBC_NO_UPDATE_NOTICE: "1" };
  const ssOut = () =>
    execFileSync(process.execPath, [cli, "hook", "session-start"], {
      cwd: proj,
      env,
      input: JSON.stringify({ cwd: proj, source: "startup" }),
      encoding: "utf8",
    });
  const add = (t) =>
    execFileSync(process.execPath, [cli, "defer", "add", t], { cwd: proj, env, encoding: "utf8" });
  try {
    // 잔여 0 + muted → 음소거 환기줄 없음(노이즈 차단)
    setStopHintMuted(proj, true);
    assert.doesNotMatch(ssOut(), /음소거 중/);
    // 미해결 defer 추가 + muted → hint + 음소거 환기 1줄
    add("남은 작업");
    const out = ssOut();
    assert.match(out, /이전 작업 잔여/); // 기존 hint 유지
    assert.match(out, /음소거 중/);
    assert.match(out, /gbc-mute/);
    // unmute → 환기줄 사라짐(hint는 유지)
    setStopHintMuted(proj, false);
    const out2 = ssOut();
    assert.match(out2, /이전 작업 잔여/);
    assert.doesNotMatch(out2, /음소거 중/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("gbc status: Stop 리마인드 음소거 상태를 표기", () => {
  const proj = tmp();
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const env = { ...process.env, GBC_NO_UPDATE_NOTICE: "1" };
  const status = () =>
    execFileSync(process.execPath, [cli, "status"], { cwd: proj, env, encoding: "utf8" });
  try {
    assert.match(status(), /Stop 리마인드: 🔔 켜짐/);
    setStopHintMuted(proj, true);
    assert.match(status(), /Stop 리마인드: 🔕 음소거/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("cached-skip(0.3.0): 통과된 작업단위 편집에도 업데이트 배너 emit + 세션당 dedup", () => {
  const proj = tmp();
  const home = tmp();
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  try {
    // 비어있지 않은 명세 + 그 해시를 gated로 시드 → cached-skip 경로 강제(judge=SDK 미호출).
    const specText = "로그인 빈 자격증명 거부";
    const specFile = join(proj, "plan.md");
    writeFileSync(specFile, specText);
    markGated(proj, computeSpecHash(specText), "이미 통과");
    // HOME에 신버전 캐시(신선) → version 안내 발화 조건(설치<9.9.9).
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeVersionCache({ latest: "9.9.9", checkedAt: Date.now() }, home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GBC_SPEC_FILE: specFile };
    delete env.GBC_NO_UPDATE_NOTICE;
    const run = (session) =>
      execFileSync(process.execPath, [cli, "hook", "pre-tool-use"], {
        cwd: proj,
        env,
        input: JSON.stringify({
          tool_name: "Edit",
          cwd: proj,
          session_id: session,
          tool_input: { file_path: join(proj, "a.txt"), old_string: "x", new_string: "y" },
        }),
        encoding: "utf8",
      });
    // 통과된 단위(cached-skip)인데도 배너가 떠야 한다(0.2.x 가시성 갭 수정).
    assert.match(run("sess-A"), /신버전 9\.9\.9/);
    // 같은 세션 재실행 → dedup(세션당 1회) → 무음.
    assert.doesNotMatch(run("sess-A"), /신버전 9\.9\.9/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("gbc init --yes: gate + gbc-mute 스킬 둘 다 설치", () => {
  const proj = tmp();
  // HOME 오버라이드 필수 — 없으면 B0 자동등록이 실사용자 ~/.gbc/repos.json에 /tmp 픽스처를
  // 누적 오염시킨다(테스트 1회당 1건, 0.5.2·0.5.3 두 차례 실측된 재발 원인).
  const home = tmp();
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GBC_NO_UPDATE_NOTICE: "1" };
  try {
    execFileSync(process.execPath, [cli, "init", "--yes"], { cwd: proj, env, encoding: "utf8" });
    assert.ok(
      readFileSync(join(proj, ".claude", "skills", "gate", "SKILL.md"), "utf8").length > 0,
      "gate 스킬 설치",
    );
    assert.ok(
      readFileSync(join(proj, ".claude", "skills", "gbc-mute", "SKILL.md"), "utf8").includes(
        "gbc-mute",
      ),
      "gbc-mute 스킬 설치",
    );
    const reg = join(home, ".gbc", "repos.json");
    assert.ok(
      !existsSync(reg) || JSON.parse(readFileSync(reg, "utf8")).every((r) => r === proj),
      "자동등록은 오버라이드된 홈에만 기록(실홈 미오염 회귀가드)",
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("gbc update --dry-run: .gbc 있으면 npm 설치+init 2단계, 없으면 init 생략 안내", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const env = { ...process.env, GBC_NO_UPDATE_NOTICE: "1" };
  const dry = (cwd) =>
    execFileSync(process.execPath, [cli, "update", "--dry-run"], { cwd, env, encoding: "utf8" });
  // gbc 프로젝트(.gbc 존재) → 2단계
  const proj = tmp();
  execFileSync(process.execPath, [cli, "defer", "add", "x"], { cwd: proj, env, encoding: "utf8" }); // .gbc 생성
  // 비-프로젝트(.gbc 없음) → init 생략 안내
  const bare = tmp();
  try {
    const a = dry(proj);
    assert.match(a, /npm i -g geobuke-code@latest/);
    assert.match(a, /gbc init --yes/);
    const b = dry(bare);
    assert.match(b, /npm i -g geobuke-code@latest/);
    assert.doesNotMatch(b, /\$ gbc init --yes/); // init 단계 없음
    assert.match(b, /init 생략/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
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

test("archiveSpec: 본문 아카이브 후 spec 비움, 빈 spec은 null (ST3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-done-"));
  try {
    // 빈 spec → 아카이브할 것 없음
    assert.equal(archiveSpec(dir), null);
    addSpecCase(dir, "케이스1 완료");
    addSpecCase(dir, "케이스2 완료");
    const archivePath = archiveSpec(dir);
    assert.ok(archivePath, "아카이브 경로 반환");
    assert.match(archivePath, /spec\.archive/);
    assert.ok(existsSync(archivePath), "아카이브 파일 생성됨");
    assert.match(readFileSync(archivePath, "utf8"), /케이스1 완료/);
    // spec 본문 비워짐 = 다음 작업단위로 깨끗이
    assert.equal(readSpecCases(dir).length, 0);
    // 비운 뒤 재호출은 다시 null
    assert.equal(archiveSpec(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addSpecCase: 정규화 동일 케이스 중복 등록 skip (ST2)", () => {
  const dir = tmp();
  try {
    assert.equal(addSpecCase(dir, "중복 이메일 검증"), true); // 최초=등록
    assert.equal(addSpecCase(dir, "  중복 이메일 검증  "), false); // 정규화 동일=skip
    assert.equal(readSpecCases(dir).length, 1);
    assert.equal(addSpecCase(dir, "다른 케이스"), true); // 다른 건 등록
    assert.equal(readSpecCases(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addDefer: 미해결 동일 항목 중복 등록 skip, resolved는 재등록 허용 (ST2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-dedup-"));
  try {
    const r1 = addDefer(dir, "C4 무관");
    assert.equal(r1.added, true);
    const r2 = addDefer(dir, " C4 무관 "); // 정규화 동일 + 미해결 → skip
    assert.equal(r2.added, false);
    assert.equal(loadDefers(dir).length, 1);
    // resolve 후 같은 텍스트 재등록은 허용(정당한 재-defer)
    resolveDefer(dir, "1");
    const r3 = addDefer(dir, "C4 무관");
    assert.equal(r3.added, true);
    assert.equal(loadDefers(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeCase: trim + 줄바꿈→공백 + 길이 상한 절단 (단일 소스)", () => {
  assert.equal(normalizeCase("  앞뒤 공백  "), "앞뒤 공백");
  assert.equal(normalizeCase("줄1\n줄2\n줄3"), "줄1 줄2 줄3");
  assert.equal(normalizeCase("a\n\n\nb"), "a b"); // 연속 개행도 단일 공백
  assert.equal(normalizeCase("x".repeat(1000)).length, MAX_CASE); // 500자 절단
});

test("addDefer: 멀티라인·장문 입력을 한 줄로 정규화 (spec add와 대칭, W2)", () => {
  const dir = tmp();
  try {
    addDefer(dir, "미룬케이스\n둘째 줄\n셋째 줄");
    const items = activeDeferItems(dir);
    assert.equal(items.length, 1);
    assert.match(items[0], /미룬케이스 둘째 줄 셋째 줄/); // 줄바꿈→공백
    assert.doesNotMatch(items[0], /\n/); // 개행 제거됨
    // 길이 상한(500자) 절단 — spec add와 동일 상한
    addDefer(dir, "y".repeat(1000));
    assert.ok(activeDeferItems(dir)[1].length <= 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldCacheVerdict: 명세 있는 정상 pass만 캐시, fail-open·block·빈명세는 캐시 안 함", () => {
  // 명세 있고(specEmpty=false) 정상 pass → 캐시
  assert.equal(shouldCacheVerdict({ verdict: "pass", missing: [], reason: "ok" }, false), true);
  // fail-open pass는 캐시 제외 (일시 장애가 작업단위 내내 게이트 무력화 방지)
  assert.equal(
    shouldCacheVerdict({ verdict: "pass", missing: [], reason: "x", failOpen: true }, false),
    false,
  );
  assert.equal(shouldCacheVerdict({ verdict: "block", missing: [], reason: "y" }, false), false);
  // 빈 명세 pass는 절대 캐시 안 함 — 빈-spec hash는 상수라 캐시 시 게이트 영구 우회(06-22 결함)
  assert.equal(shouldCacheVerdict({ verdict: "pass", missing: [], reason: "ok" }, true), false);
});

test("buildSessionStartHint: in_progress/open 차등 표시 + 행동규약 임베드 (ST4, 0.2.5)", () => {
  // 잔여 없음 → 무출력(빈 문자열)
  assert.equal(buildSessionStartHint([]), "");
  // 미해결 항목(open+in_progress) → 건수 + 차등 목록
  const hint = buildSessionStartHint([
    { item: "케이스 X 진행", at: "t", status: "in_progress" },
    { item: "케이스 Y 미착수", at: "t", status: "open" },
  ]);
  assert.match(hint, /미해결 defer 2건/);
  assert.match(hint, /진행중 1/, "in_progress 건수를 open과 구분 표면화");
  assert.match(hint, /미착수 1/, "open 건수를 in_progress와 구분 표면화");
  assert.match(hint, /케이스 X 진행/);
  assert.match(hint, /케이스 Y 미착수/);
  // 행동규약(자연어 전환 안내)이 hint 문자열에 실려야 한다 — SKILL.md만은 dead doc(advisor 필수①)
  assert.match(hint, /start/, "착수 규약 안내");
  assert.match(hint, /resolve/, "완료선언 시 종결 규약 안내");
});

test("hint 번호 = CLI 인덱스 일치: resolved가 앞에 있어도 표시 번호로 resolve가 맞는 항목을 친다 (ST4 버그수정, 0.2.5)", () => {
  const dir = tmp();
  try {
    addDefer(dir, "A 항목");
    addDefer(dir, "B 항목");
    resolveDefer(dir, "1"); // A를 resolved로 — 이제 [A:resolved, B:open]
    // 빌더는 전체 리스트를 받아 미해결만 보이되, 번호는 전체-리스트 위치로 매긴다
    const hint = buildSessionStartHint(loadDefers(dir));
    assert.match(hint, /미해결 defer 1건/, "resolved는 건수에서 제외");
    assert.doesNotMatch(hint, /A 항목/, "resolved 항목은 hint에 표시되지 않아야 한다");
    assert.match(hint, /2\. \[미착수\] B 항목/, "미해결 항목은 전체-리스트 번호(2)로 표시 — 인덱스 ref와 일치");
    // hint가 보여준 번호(2)로 resolve하면 바로 그 B를 친다
    const r = resolveDefer(dir, "2");
    assert.equal(r.length, 1);
    assert.equal(r[0].item, "B 항목");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildStopReminder: 미해결 defer 차등 표시 + 규약, 없으면 빈 문자열 (ST4, 0.2.5)", () => {
  assert.equal(buildStopReminder([]), "");
  const r = buildStopReminder([
    { item: "착수한 케이스", at: "t", status: "in_progress" },
    { item: "안 건드린 케이스", at: "t", status: "open" },
  ]);
  assert.match(r, /미해결 defer 2건/);
  assert.match(r, /진행중 1/);
  assert.match(r, /resolve/);
});

test("buildSessionStartCommand: 셸 무관 pure 명령 (session-start)", () => {
  assert.equal(
    buildSessionStartCommand("/x/dist/cli.js"),
    'node "/x/dist/cli.js" hook session-start',
  );
});

test("ensureSessionStartHook: matcher startup|resume로 멱등 등록", () => {
  const s = {};
  assert.equal(ensureSessionStartHook(s, "/x/dist/cli.js"), true); // 신규 추가
  assert.equal(s.hooks.SessionStart[0].matcher, "startup|resume");
  assert.equal(
    s.hooks.SessionStart[0].hooks[0].command,
    'node "/x/dist/cli.js" hook session-start',
  );
  // 멱등 — 두 번째 호출은 추가 안 함
  assert.equal(ensureSessionStartHook(s, "/x/dist/cli.js"), false);
  assert.equal(s.hooks.SessionStart.length, 1);
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
  assert.match(r, /gbc gate review/); // A1: 일괄 분류 체크리스트 경로 안내
});

test("buildPreCommand: 셸 무관 순수 명령 (키 prefix·셸 확장 없음)", () => {
  const cmd = buildPreCommand("/home/u/dist/cli.js");
  assert.equal(cmd, 'node "/home/u/dist/cli.js" hook pre-tool-use');
  assert.doesNotMatch(cmd, /ANTHROPIC_API_KEY/); // 셸 키주입 없음(코드가 키 해석)
  assert.doesNotMatch(cmd, /\$\(/); // $(cat ...) 셸 확장 없음
});

test("buildPreCommand: Windows 경로 백슬래시 보존 (이중 이스케이프 금지)", () => {
  // 난 WSL이라 native Windows 실행은 못 하지만, Windows 경로 입력→출력으로 요구를 검증한다.
  const cmd = buildPreCommand("C:\\Users\\me\\dist\\cli.js");
  assert.equal(cmd, 'node "C:\\Users\\me\\dist\\cli.js" hook pre-tool-use');
  assert.doesNotMatch(cmd, /\\\\/); // 백슬래시가 \\로 안 깨짐 (JSON.stringify가 파일기록 시 처리)
});

test("normalizeHooks: 기존 hook(keyless·옛 bash 키주입)을 pure 명령으로 정규화(멱등)", () => {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit",
          // 옛 bash 키주입 prefix 형태
          hooks: [
            {
              type: "command",
              command:
                'ANTHROPIC_API_KEY="$(cat "$HOME/.gbc/api-key")" node "/x/dist/cli.js" hook pre-tool-use',
            },
          ],
        },
      ],
    },
  };
  const n = normalizeHooks(settings, "/x/dist/cli.js");
  assert.equal(n, 1); // 1건 정규화
  assert.equal(
    settings.hooks.PreToolUse[0].hooks[0].command,
    'node "/x/dist/cli.js" hook pre-tool-use',
  );
  assert.doesNotMatch(settings.hooks.PreToolUse[0].hooks[0].command, /ANTHROPIC_API_KEY/);
  // 이미 pure → 재정규화 안 함(멱등)
  assert.equal(normalizeHooks(settings, "/x/dist/cli.js"), 0);
});

// ---------- ②init-staleness 감지 + 업데이트 안내 (ST3) ----------
const CLI = "/x/dist/cli.js";
function pureSettings() {
  return {
    hooks: {
      PreToolUse: [
        { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: `node "${CLI}" hook pre-tool-use` }] },
      ],
      SessionStart: [
        { matcher: "startup|resume", hooks: [{ type: "command", command: `node "${CLI}" hook session-start` }] },
      ],
    },
  };
}
function staleSettings() {
  // 옛 bash 키주입 PreToolUse + SessionStart 누락 (0.2.1 이하 init 코호트)
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [
            { type: "command", command: `ANTHROPIC_API_KEY="$(cat "$HOME/.gbc/api-key")" node "${CLI}" hook pre-tool-use` },
          ],
        },
      ],
    },
  };
}

test("hasStalePreToolUse / hasSessionStartHook: read-only 감지(비파괴)", () => {
  const pure = pureSettings();
  assert.equal(hasStalePreToolUse(pure, CLI), false);
  assert.equal(hasSessionStartHook(pure), true);
  const stale = staleSettings();
  assert.equal(hasStalePreToolUse(stale, CLI), true);
  assert.equal(hasSessionStartHook(stale), false);
  // 감지는 settings를 수정하지 않는다(normalizeHooks와 달리)
  assert.equal(stale.hooks.PreToolUse[0].hooks[0].command.includes("ANTHROPIC_API_KEY"), true);
});

test("buildInitStalenessNotice: 구버전/누락이면 init 재실행 안내, 최신이면 빈 문자열", () => {
  assert.equal(buildInitStalenessNotice(pureSettings(), CLI), ""); // 최신 → 무출력
  const n1 = buildInitStalenessNotice(staleSettings(), CLI);
  assert.match(n1, /gbc init/);
  assert.match(n1, /SessionStart/); // 누락 사유 명시
  // PreToolUse는 pure지만 SessionStart만 누락된 코호트도 감지
  const onlyMissingSession = { hooks: { PreToolUse: pureSettings().hooks.PreToolUse } };
  assert.match(buildInitStalenessNotice(onlyMissingSession, CLI), /gbc init/);
});

// ---------- B-잔여 #3: dev placeholder 경로전략 ----------
// dev(도그푸딩) 설치는 hook 명령을 절대경로 대신 ${CLAUDE_PROJECT_DIR} placeholder로 굽는다.
// read-time(hasStalePreToolUse)은 런타임 cliPath=절대경로뿐이라 placeholder를 구식으로 오판하면
// 안 된다 — 두 정식 형태(절대 OR placeholder)를 모두 인정해야 false-positive 나그가 안 뜬다.
function devPlaceholderSettings() {
  return {
    hooks: {
      PreToolUse: [
        { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: `node "${DEV_PLACEHOLDER}" hook pre-tool-use` }] },
      ],
      SessionStart: [
        { matcher: "startup|resume", hooks: [{ type: "command", command: `node "${DEV_PLACEHOLDER}" hook session-start` }] },
      ],
    },
  };
}

test("hasStalePreToolUse: dev placeholder는 절대경로 런타임에서도 stale 아님(false-positive 방지)", () => {
  // 핵심 판별 — placeholder settings를 절대경로 cliPath로 검사해도 stale=false여야 한다.
  assert.equal(hasStalePreToolUse(devPlaceholderSettings(), CLI), false);
  // 진짜 구식(옛 bash 키주입)은 여전히 stale=true (canonical 집합에 없음)
  assert.equal(hasStalePreToolUse(staleSettings(), CLI), true);
  // buildInitStalenessNotice도 placeholder면 무출력(나그 안 뜸)
  assert.equal(buildInitStalenessNotice(devPlaceholderSettings(), CLI), "");
});

test("normalizeHooks: dev placeholder를 절대경로로 덮지 않는다(정식이면 skip)", () => {
  const dev = devPlaceholderSettings();
  // placeholder는 정식 → 변경 0건, 명령 보존(도그푸딩 설치 안 깨짐)
  assert.equal(normalizeHooks(dev, CLI), 0);
  assert.equal(
    dev.hooks.PreToolUse[0].hooks[0].command,
    `node "${DEV_PLACEHOLDER}" hook pre-tool-use`,
  );
  // 절대경로 정식도 skip(멱등), 진짜 구식만 교체됨은 기존 테스트가 커버
  assert.equal(normalizeHooks(pureSettings(), CLI), 0);
});

test("DEV_PLACEHOLDER: CC가 치환하는 ${CLAUDE_PROJECT_DIR} 형식", () => {
  assert.equal(DEV_PLACEHOLDER, "${CLAUDE_PROJECT_DIR}/dist/cli.js");
  // buildPreCommand로 감싸면 셸 무관 순수 명령(절대경로와 동일 규약)
  assert.equal(buildPreCommand(DEV_PLACEHOLDER), 'node "${CLAUDE_PROJECT_DIR}/dist/cli.js" hook pre-tool-use');
});

// ---------- B1: 크로스-repo 게이트 건강성(cliPath 무관 술어) ----------
test("hasPreToolUseGate: 게이트 hook 존재 여부만(cliPath 무관, stale도 true)", () => {
  assert.equal(hasPreToolUseGate(pureSettings()), true);
  // stale(옛 bash prefix)도 'hook pre-tool-use'는 들어있으므로 게이트 존재 = true
  assert.equal(hasPreToolUseGate(staleSettings()), true);
  // PreToolUse 자체가 없으면 게이트 죽음 = false
  assert.equal(hasPreToolUseGate({ hooks: { SessionStart: pureSettings().hooks.SessionStart } }), false);
  assert.equal(hasPreToolUseGate({}), false);
});

test("assessRepoHealth: gateDead/missingSession 플래그(isGbcProject 게이트)", () => {
  // 정상 gbc 프로젝트 — 둘 다 건강
  assert.deepEqual(assessRepoHealth(pureSettings(), true), { gateDead: false, missingSession: false });
  // SessionStart만 누락(0.2.1↓ 코호트)
  const onlyMissingSession = { hooks: { PreToolUse: pureSettings().hooks.PreToolUse } };
  assert.deepEqual(assessRepoHealth(onlyMissingSession, true), { gateDead: false, missingSession: true });
  // 게이트 hook 자체 부재(게이트 조용히 죽음) + SessionStart도 없음
  assert.deepEqual(assessRepoHealth({}, true), { gateDead: true, missingSession: true });
  // .gbc 없음(게이트 대상 아님) → 둘 다 false, 설정과 무관
  assert.deepEqual(assessRepoHealth({}, false), { gateDead: false, missingSession: false });
  assert.deepEqual(assessRepoHealth(staleSettings(), false), { gateDead: false, missingSession: false });
});

test("notice dedup: 세션당 1회 (markNotified 후 같은 세션은 wasNotified=true)", () => {
  const dir = tmp();
  try {
    assert.equal(wasNotified(dir, "S1"), false); // 최초
    markNotified(dir, "S1");
    assert.equal(wasNotified(dir, "S1"), true); // 같은 세션 → 이미 알림
    assert.equal(wasNotified(dir, "S2"), false); // 다른 세션 → 다시 알림 대상
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildUpdateNotice: GBC_NO_UPDATE_NOTICE=1 opt-out, 아니면 staleness 포함", () => {
  const prev = process.env.GBC_NO_UPDATE_NOTICE;
  try {
    process.env.GBC_NO_UPDATE_NOTICE = "1";
    assert.equal(buildUpdateNotice(staleSettings(), CLI, "0.2.3"), ""); // opt-out
    delete process.env.GBC_NO_UPDATE_NOTICE;
    assert.match(buildUpdateNotice(staleSettings(), CLI, "0.2.3"), /gbc init/); // staleness 포함
  } finally {
    if (prev === undefined) delete process.env.GBC_NO_UPDATE_NOTICE;
    else process.env.GBC_NO_UPDATE_NOTICE = prev;
  }
});

// ---------- ①version notice (ST4) ----------
test("compareVersions: major.minor.patch 숫자 비교, 비숫자는 0(거짓 안내 방지)", () => {
  assert.equal(compareVersions("0.2.2", "0.2.3"), -1);
  assert.equal(compareVersions("0.2.3", "0.2.3"), 0);
  assert.equal(compareVersions("0.3.0", "0.2.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.2.3", "0.2.3-beta.1"), 0); // prerelease 무시(코어 동일)
  assert.equal(compareVersions("abc", "0.2.3"), 0); // 비숫자 → 비교 불가 → 0
});

test("buildVersionNotice: 캐시 최신 > 현재일 때만 안내(캐시만, 네트워크 없음)", () => {
  assert.match(buildVersionNotice("0.2.2", { latest: "0.2.3", checkedAt: 0 }), /신버전 0\.2\.3/);
  assert.equal(buildVersionNotice("0.2.3", { latest: "0.2.3", checkedAt: 0 }), ""); // 동일 → 무
  assert.equal(buildVersionNotice("0.2.4", { latest: "0.2.3", checkedAt: 0 }), ""); // 상위 → 무
  assert.equal(buildVersionNotice("0.2.2", null), ""); // 캐시 없음 → 무
});

test("isCacheStale: 캐시 없음 또는 24h 초과면 stale", () => {
  const now = 1_000_000_000_000;
  assert.equal(isCacheStale(null, now), true);
  assert.equal(isCacheStale({ latest: "0.2.3", checkedAt: now }, now), false);
  assert.equal(isCacheStale({ latest: "0.2.3", checkedAt: now - 25 * 3600 * 1000 }, now), true);
  assert.equal(isCacheStale({ latest: "0.2.3", checkedAt: now - 1000 }, now), false);
});

test("shouldRefreshCache(0.3.0): cliPath 없으면·opt-out·신선캐시면 X, stale면 O", () => {
  const now = 1_000_000_000_000;
  const home = tmp();
  const prev = process.env.GBC_NO_UPDATE_NOTICE;
  try {
    delete process.env.GBC_NO_UPDATE_NOTICE;
    // cliPath 없으면 직접 hook 호출 등 → 항상 false (캐시 무관)
    assert.equal(shouldRefreshCache(false, home, now), false);
    // 캐시 없음 = stale → true
    assert.equal(shouldRefreshCache(true, home, now), true);
    // 신선 캐시(24h 이내) → false
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeVersionCache({ latest: "0.9.9", checkedAt: now - 1000 }, home);
    assert.equal(shouldRefreshCache(true, home, now), false);
    // 24h 초과 → 다시 stale → true
    writeVersionCache({ latest: "0.9.9", checkedAt: now - 25 * 3600 * 1000 }, home);
    assert.equal(shouldRefreshCache(true, home, now), true);
    // opt-out이면 stale이어도 false
    process.env.GBC_NO_UPDATE_NOTICE = "1";
    assert.equal(shouldRefreshCache(true, home, now), false);
  } finally {
    if (prev === undefined) delete process.env.GBC_NO_UPDATE_NOTICE;
    else process.env.GBC_NO_UPDATE_NOTICE = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("version cache: write → read 라운드트립", () => {
  const home = tmp();
  try {
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeVersionCache({ latest: "0.9.9", checkedAt: 12345 }, home);
    const back = readVersionCache(home);
    assert.equal(back.latest, "0.9.9");
    assert.equal(back.checkedAt, 12345);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeVersionCache: ~/.gbc 없어도 디렉토리 생성 후 기록(신규 설치 코호트, 회귀가드)", () => {
  const home = tmp(); // .gbc 미리 만들지 않음 — api-key 없는 신규 설치 상황
  try {
    writeVersionCache({ latest: "1.2.3", checkedAt: 999 }, home);
    const back = readVersionCache(home);
    assert.ok(back, "캐시가 기록되어야 함(.gbc 자동 생성)");
    assert.equal(back.latest, "1.2.3");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildUpdateNotice: 신버전 캐시 있으면 version 라인 포함(ST4 통합)", () => {
  const home = tmp();
  const prev = process.env.GBC_NO_UPDATE_NOTICE;
  try {
    delete process.env.GBC_NO_UPDATE_NOTICE;
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeVersionCache({ latest: "0.9.9", checkedAt: Date.now() }, home);
    // 최신 settings(staleness 없음)인데도 version 안내는 떠야 한다
    const n = buildUpdateNotice(pureSettings(), CLI, "0.2.3", home);
    assert.match(n, /신버전 0\.9\.9/);
  } finally {
    if (prev === undefined) delete process.env.GBC_NO_UPDATE_NOTICE;
    else process.env.GBC_NO_UPDATE_NOTICE = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("cmdStatus: 신버전 나그를 출력하지 않는다 — 업데이트 안내는 SessionStart/PreToolUse 전용 (A, 0.2.4)", () => {
  // CLI를 실제 spawn해 status 출력을 본다. fresh 캐시(checkedAt=now)라 stale-refresh가
  // 안 돌아 네트워크 없이 결정론적. latest≫현재 → 나그 트리거 조건은 충족되지만, status는
  // 진단 명령이라 안내를 노출하면 안 된다(안내 자리는 SessionStart·PreToolUse 자동 채널).
  const home = tmp();
  const proj = tmp();
  try {
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeFileSync(
      join(home, ".gbc", "version-check.json"),
      JSON.stringify({ latest: "99.0.0", checkedAt: Date.now() }),
    );
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.GBC_NO_UPDATE_NOTICE; // opt-out 무관하게 status엔 나그가 없어야 함
    const out = execFileSync(process.execPath, [cli, "status"], {
      cwd: proj,
      env,
      encoding: "utf8",
    });
    assert.match(out, /버전:/, "설치 버전 진단 줄은 유지돼야 한다");
    assert.doesNotMatch(out, /신버전|사용 가능/, "status에 업데이트 나그가 출력되면 안 된다");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
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

// ---------- B2: 크로스-repo 태깅(--all 집계 해시충돌 차단) ----------
test("tagEventsWithRepo: 비어있지 않은 specHash만 repo 태깅, 빈 센티넬 보존", () => {
  const evs = [
    { at: "t1", session: "s", specHash: "X", kind: "gate", decision: "pass" },
    { at: "t2", session: "", specHash: "", kind: "spec-add" }, // 빈 센티넬
  ];
  const tagged = tagEventsWithRepo(evs, "/repo/A");
  assert.equal(tagged[0].specHash, "/repo/A::X");
  assert.equal(tagged[1].specHash, ""); // 센티넬 보존(교차세션 제외 가드 유지)
  // 원본 불변(map 복사)
  assert.equal(evs[0].specHash, "X");
});

test("tagEventsWithRepo: 크로스-repo 동일 specHash 충돌로 인한 churn 교차오염 차단", () => {
  // repo A: specHash X에서 pass(t1). repo B: 같은 boilerplate specHash X에서 spec-add(t2>t1).
  const a = [{ at: "t1", session: "sa", specHash: "X", kind: "gate", decision: "pass" }];
  const b = [{ at: "t2", session: "sb", specHash: "X", kind: "spec-add" }];
  // 태깅 없이 순진 병합 → firstPass[X]=t1, B의 spec-add@t2가 통과후 churn으로 오집계(오염 입증)
  assert.equal(computeMetrics([...a, ...b]).m1.churnAfterPass, 1);
  // 태깅 후 → A::X엔 pass, B::X엔 pass 없음 → churn 0(오염 제거)
  const tagged = [...tagEventsWithRepo(a, "A"), ...tagEventsWithRepo(b, "B")];
  assert.equal(computeMetrics(tagged).m1.churnAfterPass, 0);
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

test("resolveApiKey: env 우선 (ANTHROPIC_API_KEY 있으면 그 값)", () => {
  const key = resolveApiKey({
    env: { ANTHROPIC_API_KEY: "sk-env" },
    homeDir: "/nonexistent",
    readFile: () => {
      throw new Error("파일 안 읽어야 함");
    },
  });
  assert.equal(key, "sk-env");
});

test("resolveApiKey: env 없으면 ~/.gbc/api-key 파일에서(+ trailing newline trim)", () => {
  const key = resolveApiKey({
    env: {},
    homeDir: "/home/u",
    readFile: (p) => {
      assert.match(p.replace(/\\/g, "/"), /\/home\/u\/\.gbc\/api-key$/);
      return "sk-file\n"; // bash $(cat)와 달리 readFileSync는 안 벗기므로 코드가 trim
    },
  });
  assert.equal(key, "sk-file"); // 개행 제거됨
});

test("resolveApiKey: env도 파일도 없으면 null (파일 읽기 실패 안전)", () => {
  const key = resolveApiKey({
    env: {},
    homeDir: "/home/u",
    readFile: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(key, null);
});

test("resolveApiKey: 파일이 공백뿐이면 null", () => {
  const key = resolveApiKey({ env: {}, homeDir: "/h", readFile: () => "  \n " });
  assert.equal(key, null);
});

test("safeModel: 셸 안전 토큰만 통과, 메타문자는 기본값(W3 win32 argv 인젝션 차단)", () => {
  assert.equal(safeModel("claude-haiku-4-5"), "claude-haiku-4-5");
  assert.equal(safeModel("a.b-c_1"), "a.b-c_1"); // 영숫자/./-/_ 허용
  assert.equal(safeModel("haiku; rm -rf /"), "claude-haiku-4-5"); // ; 공백 → 기본값
  assert.equal(safeModel("$(whoami)"), "claude-haiku-4-5"); // 명령치환 → 기본값
  assert.equal(safeModel("a|b"), "claude-haiku-4-5"); // 파이프 → 기본값
  assert.equal(safeModel(""), "claude-haiku-4-5"); // 빈 값 → 기본값
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

test("buildCrossRepoHint: 타 repo 미해결 카운트만, 현재 cwd·빈 repo·부재경로 제외 (0.2.9)", () => {
  const here = tmp();
  const other1 = tmp();
  const other2 = tmp();
  const clean = tmp();
  try {
    // other1: open 2 + in_progress 1
    addDefer(other1, "A");
    addDefer(other1, "B");
    addDefer(other1, "C");
    startDefer(other1, "C");
    // other2: open 1
    addDefer(other2, "X");
    // here(현재 cwd): 미해결 있어도 제외
    addDefer(here, "HERE");
    // clean: 미해결 0 → 제외

    assert.equal(buildCrossRepoHint([], here), "");

    const hint = buildCrossRepoHint(
      [here, other1, other2, clean, join(here, "no-such-path")],
      here,
    );
    assert.ok(hint.startsWith("🌐 타 repo 미해결:"));
    // 현재 cwd 제외
    assert.ok(!hint.includes("HERE"));
    // clean(미해결 0) 제외
    assert.ok(!hint.includes(clean.split(/[\\/]/).pop()));
    // other1: 진행중1·미착수2 (카운트만)
    assert.ok(hint.includes(`${other1.split(/[\\/]/).pop()} 진행중1·미착수2`));
    // other2: 미착수1 (진행중 토큰 없음)
    assert.ok(hint.includes(`${other2.split(/[\\/]/).pop()} 미착수1`));
    // 번호 리스트 미포함(카운트만) — "1." 같은 인덱스 마커 없음
    assert.ok(!/\b\d+\.\s/.test(hint));
  } finally {
    for (const d of [here, other1, other2, clean]) rmSync(d, { recursive: true, force: true });
  }
});

test("buildCrossRepoHint: 모든 repo 미해결 0이면 빈 문자열 (0.2.9)", () => {
  const a = tmp();
  const b = tmp();
  const here = tmp();
  try {
    addDefer(a, "done");
    resolveDefer(a, "done");
    assert.equal(buildCrossRepoHint([a, b], here), "");
  } finally {
    for (const d of [a, b, here]) rmSync(d, { recursive: true, force: true });
  }
});

test("repos registry: add(멱등)/load/remove, ~/.gbc/repos.json (0.2.9)", () => {
  const fakeHome = tmp();
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome; // win32 homedir()
  const r1 = tmp();
  const r2 = tmp();
  try {
    assert.deepEqual(loadRepos(), []);
    addRepo(r1);
    addRepo(r2);
    addRepo(r1); // 멱등 — 중복 안 됨
    const after = loadRepos();
    assert.equal(after.length, 2);
    assert.ok(after.includes(resolve(r1)));
    assert.ok(after.includes(resolve(r2)));
    // remove
    const left = removeRepo(r1);
    assert.equal(left.length, 1);
    assert.ok(!left.includes(resolve(r1)));
    // 미등록 경로 remove → 변화 없음
    assert.equal(removeRepo(join(fakeHome, "nope")).length, 1);
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realProfile;
    for (const d of [fakeHome, r1, r2]) rmSync(d, { recursive: true, force: true });
  }
});

// ── A1: 펜딩-검토 모델 (review.ts) ──
const M = ["중복 이메일", "비밀번호 길이", "이메일 형식"];

test("selectCases: all → 전부 복제", () => {
  const r = selectCases(M, "all");
  assert.deepEqual(r, M);
  assert.notEqual(r, M); // 복제본(원본 보호)
});

test("selectCases: 단일/복수 정수 인덱스(1-base), 범위밖·중복 무시", () => {
  assert.deepEqual(selectCases(M, "1"), ["중복 이메일"]);
  assert.deepEqual(selectCases(M, "1 3"), ["중복 이메일", "이메일 형식"]);
  assert.deepEqual(selectCases(M, "3 1 3"), ["이메일 형식", "중복 이메일"]); // 중복 1회만, 순서 보존
  assert.deepEqual(selectCases(M, "9"), []); // 범위 밖
});

test("selectCases: 텍스트 부분매칭 1건 / 빈 ref → []", () => {
  assert.deepEqual(selectCases(M, "비밀번호"), ["비밀번호 길이"]);
  assert.deepEqual(selectCases(M, ""), []);
  assert.deepEqual(selectCases(M, "   "), []);
  assert.deepEqual(selectCases(M, "없는케이스"), []);
});

test("resolveRefs: spec/defer 분류 + spec 우선 dedup", () => {
  // 1,3 → spec / 2 → defer (서로소)
  assert.deepEqual(resolveRefs(M, "1 3", "2"), {
    toSpec: ["중복 이메일", "이메일 형식"],
    toDefer: ["비밀번호 길이"],
  });
  // 겹치면 spec 우선 — 1이 양쪽에 걸려도 toDefer에서 제외
  assert.deepEqual(resolveRefs(M, "1", "1 2"), {
    toSpec: ["중복 이메일"],
    toDefer: ["비밀번호 길이"],
  });
  // 한쪽만
  assert.deepEqual(resolveRefs(M, "all", ""), { toSpec: M, toDefer: [] });
  assert.deepEqual(resolveRefs(M, "", "all"), { toSpec: [], toDefer: M });
});

test("pending-review: write→read 라운드트립 + clear(멱등)", () => {
  const cwd = tmp();
  try {
    assert.equal(readPendingReview(cwd), null); // 부재
    const rec = { missing: M, reason: "침묵 누락", source: ".gbc/spec.md", at: "2026-06-25T00:00:00Z" };
    writePendingReview(cwd, rec);
    assert.deepEqual(readPendingReview(cwd), rec);
    clearPendingReview(cwd);
    assert.equal(readPendingReview(cwd), null);
    clearPendingReview(cwd); // 부재에도 무동작(idempotent) — throw 없어야
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- A2: 골든셋 드리프트 회귀락(순수 코어) ----------
test("goldenCaseId: 같은 입력=같은 id, 다른 입력=다른 id, 필드경계 모호성 차단", () => {
  const a = goldenCaseId("Edit", "bc", "spec");
  assert.equal(a, goldenCaseId("Edit", "bc", "spec")); // 결정론
  assert.notEqual(a, goldenCaseId("Edit", "bd", "spec")); // edit 다름
  assert.notEqual(a, goldenCaseId("Write", "bc", "spec")); // tool 다름
  assert.notEqual(a, goldenCaseId("Edit", "bc", "spec2")); // spec 다름
  // ("a","bc") vs ("ab","c") 필드 경계 충돌 방지
  assert.notEqual(goldenCaseId("a", "bc", "s"), goldenCaseId("ab", "c", "s"));
  assert.ok(a.length > 0);
});

test("diffVerdict: decisionFlip=하드, missingChanged=정보용, match", () => {
  const exp = { verdict: "block", missing: ["X", "Y"], reason: "r" };
  // 완전 일치
  assert.deepEqual(diffVerdict(exp, { verdict: "block", missing: ["Y", "X"] }), {
    decisionFlip: false,
    missingChanged: false,
    match: true,
  });
  // 판정 뒤집힘(하드)
  const flip = diffVerdict(exp, { verdict: "pass", missing: [] });
  assert.equal(flip.decisionFlip, true);
  assert.equal(flip.match, false);
  // missing만 변함(정보용) — decisionFlip=false라 회귀락은 통과
  const mc = diffVerdict(exp, { verdict: "block", missing: ["X"] });
  assert.equal(mc.decisionFlip, false);
  assert.equal(mc.missingChanged, true);
  assert.equal(mc.match, false);
  // 중복은 집합 비교라 무시
  assert.equal(diffVerdict(exp, { verdict: "block", missing: ["X", "Y", "Y"] }).missingChanged, false);
});

test("upsertGolden: 같은 id 교체(최신 expected), 다른 id 추가", () => {
  const base = [{ id: "1", expected: { verdict: "pass" } }, { id: "2", expected: { verdict: "block" } }];
  // 교체
  const u = upsertGolden(base, { id: "1", expected: { verdict: "block" } });
  assert.equal(u.length, 2);
  assert.equal(u.find((c) => c.id === "1").expected.verdict, "block");
  // 추가
  const a = upsertGolden(base, { id: "3", expected: { verdict: "pass" } });
  assert.equal(a.length, 3);
  // 원본 불변
  assert.equal(base.length, 2);
});

test("summarizeReplay: 플립/정보용변화/일치 집계 + 플립 목록", () => {
  const outcomes = [
    { id: "1", tool: "Edit", expected: "block", actual: "block", diff: { decisionFlip: false, missingChanged: false, match: true } },
    { id: "2", tool: "Edit", expected: "block", actual: "pass", diff: { decisionFlip: true, missingChanged: true, match: false } },
    { id: "3", tool: "Write", expected: "block", actual: "block", diff: { decisionFlip: false, missingChanged: true, match: false } },
  ];
  const s = summarizeReplay(outcomes);
  assert.equal(s.total, 3);
  assert.equal(s.matched, 1);
  assert.equal(s.flips, 1);
  assert.equal(s.missingOnly, 1);
  assert.equal(s.flipped.length, 1);
  assert.equal(s.flipped[0].id, "2");
});

// ===== ST1: parseBinding (사후검증 바인딩 파서) =====

test("parseBinding: ::test 바인딩 — 본문/종류/ref 분리", () => {
  const b = parseBinding("빈 자격증명 거부 ::test login_empty_creds");
  assert.equal(b.kind, "test");
  assert.equal(b.text, "빈 자격증명 거부");
  assert.equal(b.ref, "login_empty_creds");
});

test("parseBinding: ::file 바인딩 — 경로 ref", () => {
  const b = parseBinding("로그인 검증 ::file src/auth.ts");
  assert.equal(b.kind, "file");
  assert.equal(b.text, "로그인 검증");
  assert.equal(b.ref, "src/auth.ts");
});

test("parseBinding: 바인딩 없음 → none, 원문 보존", () => {
  const b = parseBinding("그냥 케이스 설명");
  assert.equal(b.kind, "none");
  assert.equal(b.text, "그냥 케이스 설명");
  assert.equal(b.ref, "");
});

test("parseBinding: 마커 앞 공백 없어도 파싱(케이스::test x)", () => {
  const b = parseBinding("케이스::test x");
  assert.equal(b.kind, "test");
  assert.equal(b.text, "케이스");
  assert.equal(b.ref, "x");
});

test("parseBinding: ref 없는 빈 마커는 바인딩으로 보지 않음(none)", () => {
  const b = parseBinding("케이스 ::test");
  assert.equal(b.kind, "none");
  assert.equal(b.text, "케이스 ::test");
});

test("parseBinding: ref 앞뒤 공백·본문 trim", () => {
  const b = parseBinding("케이스 본문   ::file   path/to/x.ts  ");
  assert.equal(b.kind, "file");
  assert.equal(b.text, "케이스 본문");
  assert.equal(b.ref, "path/to/x.ts");
});

test("parseBinding: 마지막 트레일링 바인딩이 이긴다(단일토큰 end-anchored)", () => {
  // 도그푸딩 정정: ref는 줄 끝 단일 토큰 → 앞의 '::test a'는 산문, 트레일링 '::file b'가 바인딩.
  const b = parseBinding("케이스 ::test a ::file b");
  assert.equal(b.kind, "file");
  assert.equal(b.ref, "b");
  assert.equal(b.text, "케이스 ::test a");
});

test("parseBinding: 산문 중간 '::test 본문...'은 바인딩 아님(none) — 도그푸딩 회귀", () => {
  // 케이스 본문이 마커 단어를 서술적으로 포함하고 뒤에 토큰이 더 이어지면 트레일링 바인딩 아님.
  const b = parseBinding("verify가 spec 케이스의 ::test 바인딩을 결과와 매칭해 판정한다");
  assert.equal(b.kind, "none");
  assert.equal(b.text, "verify가 spec 케이스의 ::test 바인딩을 결과와 매칭해 판정한다");
});

test("parseBinding: 따옴표 ref로 공백 포함 테스트명(BDD)", () => {
  const b = parseBinding('빈 자격증명 ::test "should reject empty creds"');
  assert.equal(b.kind, "test");
  assert.equal(b.ref, "should reject empty creds");
  assert.equal(b.text, "빈 자격증명");
});

// readSpecCases가 반환한 케이스에 바인딩 접미사가 그대로 실려 옴을 확인(접미사 누수 회귀)
test("parseBinding: readSpecCases 출력의 접미사를 분리할 수 있다", () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "비밀번호 8자 검증 ::test pw_len");
    const cases = readSpecCases(dir);
    assert.equal(cases.length, 1);
    const b = parseBinding(cases[0]);
    assert.equal(b.kind, "test");
    assert.equal(b.text, "비밀번호 8자 검증");
    assert.equal(b.ref, "pw_len");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== ST2: parseJUnit / readVerifyResults (JUnit 리더, verified 경로) =====

const JUNIT_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="auth" tests="4" failures="1" errors="1" skipped="1">
    <testcase name="login_empty_creds" classname="auth" time="0.01"/>
    <testcase name="login_pwlen" classname="auth" time="0.02">
      <failure message="expected reject">AssertionError</failure>
    </testcase>
    <testcase name="login_boom" classname="auth">
      <error message="threw">TypeError</error>
    </testcase>
    <testcase name="login_todo" classname="auth">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;

test("parseJUnit: self-closed testcase = pass", () => {
  const m = parseJUnit(JUNIT_SAMPLE);
  assert.equal(m.get("login_empty_creds"), "pass");
});

test("parseJUnit: <failure> 자식 = fail", () => {
  const m = parseJUnit(JUNIT_SAMPLE);
  assert.equal(m.get("login_pwlen"), "fail");
});

test("parseJUnit: <error> 자식 = fail", () => {
  const m = parseJUnit(JUNIT_SAMPLE);
  assert.equal(m.get("login_boom"), "fail");
});

test("parseJUnit: <skipped> 자식 = skipped", () => {
  const m = parseJUnit(JUNIT_SAMPLE);
  assert.equal(m.get("login_todo"), "skipped");
});

test("parseJUnit: 빈/깨진 XML → 빈 맵(throw 안 함)", () => {
  assert.equal(parseJUnit("").size, 0);
  assert.equal(parseJUnit("not xml <broken").size, 0);
});

test("parseJUnit: 작은따옴표 속성 + XML 엔티티 디코드", () => {
  const xml = `<testsuite><testcase name='a&amp;b &lt;x&gt;'/></testsuite>`;
  const m = parseJUnit(xml);
  assert.equal(m.get("a&b <x>"), "pass");
});

test("parseJUnit: 동일 이름 중복 시 fail이 sticky(재시도 1pass 1fail → fail)", () => {
  const xml = `<testsuite>
    <testcase name="flaky"/>
    <testcase name="flaky"><failure/></testcase>
  </testsuite>`;
  assert.equal(parseJUnit(xml).get("flaky"), "fail");
});

test("parseJUnit: ::testing 같은 단어내부는 testcase 아님(name만 추출)", () => {
  // testcase 태그만 인식 — testsuite 속성 등은 무시
  const xml = `<testsuite name="suite_x" tests="1"><testcase name="real_one"/></testsuite>`;
  const m = parseJUnit(xml);
  assert.equal(m.size, 1);
  assert.equal(m.get("real_one"), "pass");
});

test("readVerifyResults: .gbc/verify-results.xml 읽어 파싱", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, ".gbc"), { recursive: true });
    writeFileSync(join(dir, JUNIT_DEFAULT_REL), JUNIT_SAMPLE, "utf8");
    const m = readVerifyResults(dir);
    assert.ok(m);
    assert.equal(m.get("login_empty_creds"), "pass");
    assert.equal(m.get("login_pwlen"), "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readVerifyResults: 파일 부재 → null", () => {
  const dir = tmp();
  try {
    assert.equal(readVerifyResults(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readVerifyResults: relPath가 cwd 밖이면 컨테인먼트로 null (security S3)", () => {
  const dir = tmp();
  try {
    // 트래버설 경로 → cwd 밖 → 읽지 않고 null(파일 존재 여부와 무관하게 거부).
    assert.equal(readVerifyResults(dir, "../../../etc/passwd"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== ST3: reviewed judge (LLM 독해·경량). fail-open→unverifiable 가드 =====

test("parseReviewVerdict: pass JSON → pass", () => {
  const v = parseReviewVerdict('{"status":"pass","reason":"빈 자격증명 분기 존재"}');
  assert.equal(v.status, "pass");
  assert.equal(v.reason, "빈 자격증명 분기 존재");
});

test("parseReviewVerdict: fail JSON → fail", () => {
  const v = parseReviewVerdict('{"status":"fail","reason":"분기 없음"}');
  assert.equal(v.status, "fail");
});

test("parseReviewVerdict: 파싱 불가 → unverifiable (pass 아님!)", () => {
  const v = parseReviewVerdict("그냥 텍스트 응답");
  assert.equal(v.status, "unverifiable");
  assert.notEqual(v.status, "pass");
});

test("parseReviewVerdict: 알 수 없는 status → unverifiable", () => {
  const v = parseReviewVerdict('{"status":"block","reason":"x"}');
  assert.equal(v.status, "unverifiable");
});

test("parseReviewVerdict: status 누락 → unverifiable", () => {
  const v = parseReviewVerdict('{"reason":"x"}');
  assert.equal(v.status, "unverifiable");
});

test("judgeReviewed: 주입된 pass 응답 → pass", async () => {
  const v = await judgeReviewed("케이스", "function f(){}", {
    invoke: async () => '{"status":"pass","reason":"ok"}',
  });
  assert.equal(v.status, "pass");
});

test("judgeReviewed: 주입된 fail 응답 → fail", async () => {
  const v = await judgeReviewed("케이스", "code", {
    invoke: async () => '{"status":"fail","reason":"no"}',
  });
  assert.equal(v.status, "fail");
});

// ★ 핵심 가드 — 호출 실패(throw)는 절대 pass로 떨어지지 않고 unverifiable이어야 한다.
test("judgeReviewed: invoke가 throw → unverifiable (NOT pass)", async () => {
  const v = await judgeReviewed("케이스", "code", {
    invoke: async () => {
      throw new Error("API 다운");
    },
  });
  assert.equal(v.status, "unverifiable");
  assert.notEqual(v.status, "pass");
});

test("judgeReviewed: 주입된 garbage 응답 → unverifiable", async () => {
  const v = await judgeReviewed("케이스", "code", {
    invoke: async () => "보장 없는 잡음",
  });
  assert.equal(v.status, "unverifiable");
});

test("buildReviewMessage: 케이스·코드 본문 포함 + 긴 코드 절단", () => {
  const msg = buildReviewMessage("내 케이스", "X".repeat(20000));
  assert.match(msg, /내 케이스/);
  assert.match(msg, /최종 코드/);
  assert.match(msg, /절단됨/);
});

// ===== ST4: runVerify 오케스트레이터 (바인딩별 라우팅) =====

const PASS_REVIEWER = async () => ({ status: "pass", reason: "독해 충족" });
const FAIL_REVIEWER = async () => ({ status: "fail", reason: "독해 미충족" });
const UNVER_REVIEWER = async () => ({ status: "unverifiable", reason: "검토 실패" });

function writeJunit(dir, xml) {
  mkdirSync(join(dir, ".gbc"), { recursive: true });
  writeFileSync(join(dir, JUNIT_DEFAULT_REL), xml, "utf8");
}

test("runVerify: ::test 통과 → verified/pass", async () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "빈 자격증명 거부 ::test t_empty");
    writeJunit(dir, `<testsuite><testcase name="t_empty"/></testsuite>`);
    const r = await runVerify(dir, { now: "T" });
    assert.equal(r.cases.length, 1);
    assert.equal(r.cases[0].level, "verified");
    assert.equal(r.cases[0].status, "pass");
    assert.equal(r.cases[0].case, "빈 자격증명 거부");
    assert.equal(r.at, "T");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: ::test 실패 → verified/fail", async () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "비번 길이 ::test t_pw");
    writeJunit(dir, `<testsuite><testcase name="t_pw"><failure/></testcase></testsuite>`);
    const r = await runVerify(dir);
    assert.equal(r.cases[0].level, "verified");
    assert.equal(r.cases[0].status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: ::test 결과파일 없음 → unverifiable(junit:none)", async () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "케이스 ::test t_x");
    const r = await runVerify(dir);
    assert.equal(r.cases[0].level, "unverifiable");
    assert.equal(r.cases[0].source, "junit:none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: ::test 결과에 해당 테스트 없음 → unverifiable(junit:miss)", async () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "케이스 ::test t_missing");
    writeJunit(dir, `<testsuite><testcase name="other"/></testsuite>`);
    const r = await runVerify(dir);
    assert.equal(r.cases[0].level, "unverifiable");
    assert.equal(r.cases[0].source, "junit:miss");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: ::test skip → unverifiable(미실행)", async () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "케이스 ::test t_skip");
    writeJunit(dir, `<testsuite><testcase name="t_skip"><skipped/></testcase></testsuite>`);
    const r = await runVerify(dir);
    assert.equal(r.cases[0].level, "unverifiable");
    assert.equal(r.cases[0].source, "junit:skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: ::file 독해 충족 → reviewed/pass (주입 reviewer)", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "auth.ts"), "function login(){}", "utf8");
    addSpecCase(dir, "로그인 ::file auth.ts");
    const r = await runVerify(dir, { reviewer: PASS_REVIEWER });
    assert.equal(r.cases[0].level, "reviewed");
    assert.equal(r.cases[0].status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: ::file 독해 미충족 → reviewed/fail", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "auth.ts"), "x", "utf8");
    addSpecCase(dir, "로그인 ::file auth.ts");
    const r = await runVerify(dir, { reviewer: FAIL_REVIEWER });
    assert.equal(r.cases[0].level, "reviewed");
    assert.equal(r.cases[0].status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: ::file reviewer가 unverifiable(fail-open) → unverifiable (NOT pass)", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "auth.ts"), "x", "utf8");
    addSpecCase(dir, "로그인 ::file auth.ts");
    const r = await runVerify(dir, { reviewer: UNVER_REVIEWER });
    assert.equal(r.cases[0].level, "unverifiable");
    assert.notEqual(r.cases[0].status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: ::file 파일 없음 → unverifiable(review:nofile), reviewer 미호출", async () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "로그인 ::file 없는파일.ts");
    let called = false;
    const r = await runVerify(dir, {
      reviewer: async () => {
        called = true;
        return { status: "pass", reason: "x" };
      },
    });
    assert.equal(r.cases[0].level, "unverifiable");
    assert.equal(r.cases[0].source, "review:nofile");
    assert.equal(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: ::file이 cwd 밖 가리키면 거부 → unverifiable(review:outside), 미읽음", async () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "유출 시도 ::file ../../../etc/passwd");
    let called = false;
    const r = await runVerify(dir, {
      reviewer: async () => {
        called = true;
        return { status: "pass", reason: "x" };
      },
    });
    assert.equal(r.cases[0].level, "unverifiable");
    assert.equal(r.cases[0].source, "review:outside");
    assert.equal(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: cwd 내부 심링크가 밖을 가리켜도 거부(읽지 않음) — scope-critic 高", async () => {
  const dir = tmp();
  try {
    // dir/leak → /etc/hostname(cwd 밖). 어휘 컨테인먼트는 통과(경로는 dir 안)하지만 lstat이 거부.
    const link = join(dir, "leak");
    try {
      symlinkSync("/etc/hostname", link);
    } catch {
      return; // 심링크 미지원 환경(권한 등) → skip
    }
    addSpecCase(dir, "유출 ::file leak");
    let called = false;
    const r = await runVerify(dir, {
      reviewer: async () => {
        called = true;
        return { status: "pass", reason: "x" };
      },
    });
    assert.equal(r.cases[0].level, "unverifiable");
    assert.equal(r.cases[0].source, "review:nofile");
    assert.equal(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: 바인딩 없는 케이스 → unverifiable(none)", async () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "바인딩 없는 케이스");
    const r = await runVerify(dir);
    assert.equal(r.cases[0].level, "unverifiable");
    assert.equal(r.cases[0].source, "none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: 케이스 없음 → 빈 리포트", async () => {
  const dir = tmp();
  try {
    const r = await runVerify(dir);
    assert.equal(r.cases.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── buildSessionStartPayload: SessionStart 출력 청중분리(Option X) ──────────
test("buildSessionStartPayload: 힌트+안내 둘 다 → additionalContext + systemMessage 분리", () => {
  const out = JSON.parse(buildSessionStartPayload(["🐢 defer 2건", "🌐 타 repo"], "🐢 신버전 0.5.0"));
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.additionalContext, "🐢 defer 2건\n🌐 타 repo");
  assert.equal(out.systemMessage, "🐢 신버전 0.5.0");
});

test("buildSessionStartPayload: 힌트만 → additionalContext만, systemMessage 생략", () => {
  const out = JSON.parse(buildSessionStartPayload(["🐢 defer 2건"], ""));
  assert.equal(out.hookSpecificOutput.additionalContext, "🐢 defer 2건");
  assert.ok(!("systemMessage" in out), "systemMessage 키가 없어야 함");
});

test("buildSessionStartPayload: 안내만 → systemMessage만, additionalContext 생략", () => {
  const out = JSON.parse(buildSessionStartPayload([], "🐢 신버전 0.5.0"));
  assert.equal(out.systemMessage, "🐢 신버전 0.5.0");
  assert.ok(!("hookSpecificOutput" in out), "hookSpecificOutput 키가 없어야 함");
});

test("buildSessionStartPayload: 둘 다 없음 → 빈 문자열(무출력, 현행 동작 보존)", () => {
  assert.equal(buildSessionStartPayload([], ""), "");
  assert.equal(buildSessionStartPayload(["", "  "], ""), "", "빈/공백 파트만 있으면 무출력");
});

// ===== SubTask 2: scope.ts 큐 IO + grep 파싱 (0.5.2) =====

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), "gbc-scope-"));
}

function scopeEntry(over = {}) {
  return {
    file: "src/format/userName.ts",
    tool: "Edit",
    edit: "return user.name || 'Guest';",
    specHash: "abc123",
    at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

test("scope 큐: enqueue→read 라운드트립(순서 보존)", () => {
  const cwd = tmpCwd();
  try {
    enqueueScope(cwd, scopeEntry({ file: "a.ts" }));
    enqueueScope(cwd, scopeEntry({ file: "b.ts" }));
    const q = readScopeQueue(cwd);
    assert.equal(q.length, 2);
    assert.equal(q[0].file, "a.ts");
    assert.equal(q[1].file, "b.ts");
    assert.equal(q[0].edit, "return user.name || 'Guest';");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scope 큐: clear가 비운다", () => {
  const cwd = tmpCwd();
  try {
    enqueueScope(cwd, scopeEntry());
    clearScopeQueue(cwd);
    assert.deepEqual(readScopeQueue(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scope 큐: 없을 때 read는 빈 배열", () => {
  const cwd = tmpCwd();
  try {
    assert.deepEqual(readScopeQueue(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scope 큐: MAX_SCOPE_QUEUE 초과 시 최신 N만 유지(오래된 것 드롭)", () => {
  const cwd = tmpCwd();
  try {
    for (let i = 0; i < MAX_SCOPE_QUEUE + 5; i++) {
      enqueueScope(cwd, scopeEntry({ file: `f${i}.ts` }));
    }
    const q = readScopeQueue(cwd);
    assert.equal(q.length, MAX_SCOPE_QUEUE, "큐는 상한을 넘지 않는다");
    // 최신 유지: 마지막 엔트리는 가장 최근에 넣은 것
    assert.equal(q[q.length - 1].file, `f${MAX_SCOPE_QUEUE + 4}.ts`);
    // 가장 오래된 것(f0)은 드롭됨
    assert.ok(!q.some((e) => e.file === "f0.ts"), "가장 오래된 엔트리는 드롭");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parseGrepOutput: file:line:content 파싱", () => {
  const raw = "src/a.ts:12:  foo(bar)\nsrc/b.ts:3:const x = 1";
  const { matches, truncated } = parseGrepOutput(raw);
  assert.equal(truncated, false);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches[0], { file: "src/a.ts", line: 12, text: "foo(bar)" });
  assert.equal(matches[1].file, "src/b.ts");
  assert.equal(matches[1].line, 3);
});

test("parseGrepOutput: 깨진 줄·빈 줄 skip", () => {
  const raw = "src/a.ts:12:ok\n\ngarbage line no colon\nsrc/b.ts:notanumber:x\nsrc/c.ts:5:good";
  const { matches } = parseGrepOutput(raw);
  assert.equal(matches.length, 2, "정상 2줄만");
  assert.equal(matches[0].file, "src/a.ts");
  assert.equal(matches[1].file, "src/c.ts");
});

test("parseGrepOutput: 빈 입력 → 빈 matches(하드가드 트리거 신호)", () => {
  assert.deepEqual(parseGrepOutput("").matches, []);
  assert.deepEqual(parseGrepOutput("   \n  ").matches, []);
});

test("parseGrepOutput: MAX_GREP_MATCHES 초과 시 잘리고 truncated=true", () => {
  const lines = [];
  for (let i = 0; i < MAX_GREP_MATCHES + 10; i++) lines.push(`src/f.ts:${i + 1}:line${i}`);
  const { matches, truncated } = parseGrepOutput(lines.join("\n"));
  assert.equal(matches.length, MAX_GREP_MATCHES);
  assert.equal(truncated, true);
});

test("parseGrepOutput: 긴 줄은 MAX_GREP_LINE_LEN으로 절단", () => {
  const longText = "x".repeat(MAX_GREP_LINE_LEN + 200);
  const { matches } = parseGrepOutput(`src/a.ts:1:${longText}`);
  assert.ok(matches[0].text.length <= MAX_GREP_LINE_LEN, "줄 텍스트 절단");
});

test("formatGrepContext: 빈 matches → 빈 문자열", () => {
  assert.equal(formatGrepContext([]), "");
});

test("formatGrepContext: 총 길이 MAX_SCOPE_CONTEXT_CHARS 이내로 바운드", () => {
  const many = [];
  for (let i = 0; i < 500; i++) many.push({ file: `src/f${i}.ts`, line: i, text: "y".repeat(150) });
  const ctx = formatGrepContext(many);
  assert.ok(ctx.length <= MAX_SCOPE_CONTEXT_CHARS, `컨텍스트 길이 ${ctx.length} <= ${MAX_SCOPE_CONTEXT_CHARS}`);
  assert.ok(ctx.includes("src/f0.ts"), "앞쪽 매치는 포함");
});

// ===== SubTask 3: judge.ts SCOPE_SYSTEM + judgeScope + 하드가드 (0.5.2) =====

function scopeQ(over = {}) {
  return { file: "src/a.ts", tool: "Edit", edit: "x", specHash: "h", at: "t", ...over };
}

test("SCOPE_MODEL: 기본 haiku (GBC_SCOPE_MODEL 미설정 시)", () => {
  // 기본 실행 환경엔 GBC_SCOPE_MODEL 없음 → haiku
  assert.equal(SCOPE_MODEL, "claude-haiku-4-5");
});

test("parseScopeVerdicts: 정상 배치 파싱 (컨텍스트 있음 → degraded=false)", () => {
  const entries = [scopeQ({ file: "src/a.ts" })];
  const raw = JSON.stringify([
    { file: "src/a.ts", axisA: "broken", axisAReason: "Sidebar.tsx 미반영", rung: "rung2", rungReason: "text.ts 중복" },
  ]);
  const [v] = parseScopeVerdicts(raw, entries, new Set(["src/a.ts"]));
  assert.equal(v.file, "src/a.ts");
  assert.equal(v.axisA, "broken");
  assert.equal(v.rung, "rung2");
  assert.equal(v.degraded, false);
});

test("하드가드: 컨텍스트 없는 파일 → axisA 강제 unknown + degraded=true (모델이 broken이라 해도)", () => {
  const entries = [scopeQ({ file: "src/a.ts" })];
  const raw = JSON.stringify([
    { file: "src/a.ts", axisA: "broken", axisAReason: "확신", rung: "none", rungReason: "" },
  ]);
  const [v] = parseScopeVerdicts(raw, entries, new Set()); // 컨텍스트 없음
  assert.equal(v.axisA, "unknown", "탐색 근거 없이 broken 확신 차단");
  assert.equal(v.degraded, true);
});

test("하드가드: 컨텍스트 없을 때 rung2 → unknown 강제 (재사용은 grep 없이 판정 불가)", () => {
  const entries = [scopeQ({ file: "src/a.ts" })];
  const raw = JSON.stringify([
    { file: "src/a.ts", axisA: "unknown", axisAReason: "", rung: "rung2", rungReason: "있을듯" },
  ]);
  const [v] = parseScopeVerdicts(raw, entries, new Set());
  assert.equal(v.rung, "unknown", "grep 없이 rung2(중복존재) 확신 차단");
  assert.equal(v.degraded, true);
});

test("하드가드: 컨텍스트 없어도 rung1(YAGNI)/rung3(stdlib)는 유지 (grep 무관 판정)", () => {
  const entries = [scopeQ({ file: "src/a.ts" }), scopeQ({ file: "src/b.ts" })];
  const raw = JSON.stringify([
    { file: "src/a.ts", axisA: "ok", axisAReason: "", rung: "rung1", rungReason: "플러그인 과다" },
    { file: "src/b.ts", axisA: "ok", axisAReason: "", rung: "rung3", rungReason: "structuredClone 있음" },
  ]);
  const vs = parseScopeVerdicts(raw, entries, new Set()); // 컨텍스트 없음
  assert.equal(vs[0].rung, "rung1", "rung1은 grep 없이도 유지");
  assert.equal(vs[1].rung, "rung3", "rung3은 grep 없이도 유지");
  // 단 axisA는 컨텍스트 없으니 degraded
  assert.equal(vs[0].degraded, true);
});

test("parseScopeVerdicts: 응답에 없는 파일 → unknown+degraded (모델이 판정 안 함)", () => {
  const entries = [scopeQ({ file: "src/a.ts" }), scopeQ({ file: "src/missing.ts" })];
  const raw = JSON.stringify([{ file: "src/a.ts", axisA: "ok", axisAReason: "", rung: "none", rungReason: "" }]);
  const vs = parseScopeVerdicts(raw, entries, new Set(["src/a.ts", "src/missing.ts"]));
  assert.equal(vs.length, 2, "엔트리마다 하나씩(응답 누락도 채움)");
  const missing = vs.find((v) => v.file === "src/missing.ts");
  assert.equal(missing.axisA, "unknown");
  assert.equal(missing.rung, "unknown");
  assert.equal(missing.degraded, true);
});

test("parseScopeVerdicts: 파싱 불가 → 전 엔트리 unknown+degraded (broken/rung2 조작 금지)", () => {
  const entries = [scopeQ({ file: "src/a.ts" })];
  const [v] = parseScopeVerdicts("쓰레기 응답 no json", entries, new Set(["src/a.ts"]));
  assert.equal(v.axisA, "unknown");
  assert.equal(v.rung, "unknown");
  assert.equal(v.degraded, true);
});

test("parseScopeVerdicts: 잘못된 enum 값 → unknown 강제", () => {
  const entries = [scopeQ({ file: "src/a.ts" })];
  const raw = JSON.stringify([{ file: "src/a.ts", axisA: "무효값", rung: "rung9", axisAReason: "", rungReason: "" }]);
  const [v] = parseScopeVerdicts(raw, entries, new Set(["src/a.ts"]));
  assert.equal(v.axisA, "unknown");
  assert.equal(v.rung, "unknown");
});

test("buildScopeMessage: 편집들과 grep 컨텍스트를 담는다", () => {
  const entries = [scopeQ({ file: "src/a.ts", edit: "return x || 'g'" })];
  const msg = buildScopeMessage(entries, "src/other.ts:4: uses x");
  assert.ok(msg.includes("src/a.ts"), "파일 경로 포함");
  assert.ok(msg.includes("return x || 'g'"), "편집 본문 포함");
  assert.ok(msg.includes("src/other.ts:4"), "grep 컨텍스트 포함");
});

test("buildScopeMessage: 컨텍스트 없으면 '(탐색 결과 없음)' 명시", () => {
  const msg = buildScopeMessage([scopeQ()], "");
  assert.ok(/탐색 결과 없음|없음/.test(msg), "빈 컨텍스트를 명시적으로 표기");
});

test("judgeScope: 타임아웃 초과 → unknown+degraded fail-open (사유에 타임아웃 명시)", async () => {
  const entries = [scopeQ({ file: "src/a.ts" })];
  const invoke = () => new Promise(() => {}); // 영원히 안 끝나는 호출
  const t0 = Date.now();
  const vs = await judgeScope(entries, "ctx", new Set(["src/a.ts"]), { invoke, timeoutMs: 80 });
  assert.ok(Date.now() - t0 < 2000, "타임아웃이 실제로 끊는다");
  assert.equal(vs[0].axisA, "unknown");
  assert.equal(vs[0].degraded, true);
  assert.ok(vs[0].axisAReason.includes("타임아웃"), "사유에 타임아웃 명시");
});

test("buildScopeMessage: planSpec 포함(rung1 판정 조건 정렬), 없으면 '(계획 명세 없음)'", async () => {
  const withSpec = buildScopeMessage([scopeQ()], "", "apiTimeout 값 하나만 읽기");
  assert.ok(withSpec.includes("apiTimeout 값 하나만 읽기"));
  assert.ok(withSpec.includes("[계획 명세]"));
  const noSpec = buildScopeMessage([scopeQ()], "");
  assert.ok(noSpec.includes("(계획 명세 없음)"));
});

test("judgeScope: 호출 실패 → 전 엔트리 unknown+degraded (fail-open, block 아님)", async () => {
  const entries = [scopeQ({ file: "src/a.ts" })];
  const invoke = async () => {
    throw new Error("API 다운");
  };
  const vs = await judgeScope(entries, "ctx", new Set(["src/a.ts"]), { invoke });
  assert.equal(vs.length, 1);
  assert.equal(vs[0].axisA, "unknown");
  assert.equal(vs[0].degraded, true);
});

test("judgeScope: 정상 응답 파싱 + 하드가드 적용", async () => {
  const entries = [scopeQ({ file: "src/a.ts" })];
  const invoke = async () =>
    JSON.stringify([{ file: "src/a.ts", axisA: "broken", axisAReason: "r", rung: "none", rungReason: "" }]);
  const vs = await judgeScope(entries, "src/a.ts:1: hit", new Set(["src/a.ts"]), { invoke });
  assert.equal(vs[0].axisA, "broken");
  assert.equal(vs[0].degraded, false);
});

// ===== SubTask 4: extractSymbols + collectGrepContext (grep 실행 유틸) =====

test("extractSymbols: 함수·const·class 정의명 추출, 키워드·짧은 이름 제외", () => {
  const edit = "export function formatUserName(u) {\n  const fallback = 'Guest';\n  return u.name || fallback;\n}";
  const syms = extractSymbols(edit);
  assert.ok(syms.includes("formatUserName"), "함수명 추출");
  assert.ok(syms.includes("fallback"), "const명 추출");
  assert.ok(!syms.includes("const"), "키워드 제외");
  assert.ok(!syms.includes("u"), "3자 미만 제외");
});

test("extractSymbols: MAX_GREP_SYMBOLS로 상한", () => {
  let edit = "";
  for (let i = 0; i < 30; i++) edit += `function fn_symbol_${i}() {}\n`;
  assert.ok(extractSymbols(edit).length <= MAX_GREP_SYMBOLS);
});

test("collectGrepContext: 타 파일 매치 → filesWithContext 등록 + 컨텍스트 채움", async () => {
  const entries = [scopeQ({ file: "src/a.ts", edit: "function formatUserName(u){ return u.name }" })];
  // 주입 grep: formatUserName이 다른 파일(src/sidebar.ts)에서 호출됨
  const grep = async (sym) =>
    sym === "formatUserName" ? "src/sidebar.ts:41: formatUserName(user)\nsrc/a.ts:1: function formatUserName" : "";
  const { context, filesWithContext } = await collectGrepContext(".", entries, { grep });
  assert.ok(filesWithContext.has("src/a.ts"), "타 파일 매치 있으니 컨텍스트 있음으로");
  assert.ok(context.includes("src/sidebar.ts"), "타 파일 호출부가 컨텍스트에");
  assert.ok(!context.includes("src/a.ts:1"), "자기 파일 매치는 제외");
});

test("collectGrepContext: 매치 없음 → filesWithContext 비고 컨텍스트 빈문자열(하드가드 신호)", async () => {
  const entries = [scopeQ({ file: "src/a.ts", edit: "function loneSymbol(){}" })];
  const grep = async () => ""; // 아무 매치 없음
  const { context, filesWithContext } = await collectGrepContext(".", entries, { grep });
  assert.equal(context, "");
  assert.equal(filesWithContext.size, 0, "컨텍스트 없음 → 하드가드가 unknown 처리하게 됨");
});

// ===== SubTask 5: hook.ts formatScopeFindings (표면화 포맷) =====

function sv(over = {}) {
  return { file: "src/a.ts", axisA: "ok", axisAReason: "", rung: "none", rungReason: "", degraded: false, ...over };
}

test("formatScopeFindings: 액션 없음(ok+none) → 빈 문자열(불필요한 표면화 안 함)", () => {
  assert.equal(formatScopeFindings([sv()], false), "");
  assert.equal(formatScopeFindings([sv({ axisA: "unknown", rung: "unknown", degraded: true })], true), "");
});

test("formatScopeFindings: axisA broken → 파급반경 라인 포함", () => {
  const out = formatScopeFindings([sv({ axisA: "broken", axisAReason: "Sidebar 미반영" })], false);
  assert.ok(out.includes("파급반경"), "파급반경 라벨");
  assert.ok(out.includes("Sidebar 미반영"));
});

test("formatScopeFindings: rung1/2/3 → 각 라벨 포함", () => {
  assert.ok(formatScopeFindings([sv({ rung: "rung1", rungReason: "플러그인 과다" })], false).includes("과다구현"));
  assert.ok(formatScopeFindings([sv({ rung: "rung2", rungReason: "text.ts 중복" })], false).includes("기존코드 재사용"));
  assert.ok(formatScopeFindings([sv({ rung: "rung3", rungReason: "structuredClone" })], false).includes("표준라이브러리"));
});

test("formatScopeFindings: degraded + 액션 있음 → 정직 고지 한 줄 첨부", () => {
  const out = formatScopeFindings([sv({ axisA: "broken", axisAReason: "r" })], true);
  assert.ok(/생략|탐색 컨텍스트/.test(out), "degraded 고지");
});

// ===== SubTask 6: metrics.ts scope 계측 태깅 (프라이버시 불변식) =====

test("logScopeVerdicts: events.jsonl에 scope 이벤트 기록(enum 태그만)", () => {
  const cwd = tmpCwd();
  try {
    const verdicts = [
      sv({ file: "src/a.ts", axisA: "broken", axisAReason: "민감한 코드 사유 텍스트", rung: "rung2", rungReason: "비밀 스니펫" }),
    ];
    logScopeVerdicts(cwd, "sess1", verdicts, { contextMode: "grep", transport: "api", specPresent: true });
    const raw = readFileSync(join(cwd, ".gbc", "events.jsonl"), "utf8");
    const events = parseEvents(raw);
    const scopeEvts = events.filter((e) => e.kind === "scope");
    assert.equal(scopeEvts.length, 1);
    const e = scopeEvts[0];
    assert.equal(e.axis, "rung2", "rung 걸림이 coarse axis 태그");
    assert.equal(e.axisA, "broken");
    assert.equal(e.rung, "rung2");
    assert.equal(e.spec_present, true);
    assert.equal(e.context_mode, "grep");
    assert.equal(e.transport, "api");
    assert.equal(e.degraded, false);
    // 프라이버시 불변식: 코드 본문·사유 문자열이 직렬화에 절대 없어야 함
    assert.ok(!raw.includes("민감한 코드 사유 텍스트"), "axisAReason 미저장");
    assert.ok(!raw.includes("비밀 스니펫"), "rungReason 미저장");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("logScopeVerdicts: axisA broken·rung none → axis=scope 태그", () => {
  const cwd = tmpCwd();
  try {
    logScopeVerdicts(cwd, "s", [sv({ axisA: "broken", rung: "none" })], {
      contextMode: "grep",
      transport: "cli",
      specPresent: false,
    });
    const events = parseEvents(readFileSync(join(cwd, ".gbc", "events.jsonl"), "utf8"));
    assert.equal(events[0].axis, "scope");
    assert.equal(events[0].context_mode, "grep");
    assert.equal(events[0].spec_present, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("logScopeVerdicts: degraded 이벤트도 정직 기록(context_mode none)", () => {
  const cwd = tmpCwd();
  try {
    logScopeVerdicts(cwd, "s", [sv({ axisA: "unknown", rung: "unknown", degraded: true })], {
      contextMode: "none",
      transport: "api",
      specPresent: true,
    });
    const events = parseEvents(readFileSync(join(cwd, ".gbc", "events.jsonl"), "utf8"));
    assert.equal(events[0].degraded, true);
    assert.equal(events[0].context_mode, "none");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ===== 0.5.4 ST-P0-1: scope 이벤트 조인키 specHash 충전 (A2 사후대조 선행) =====

test("enrichVerdictsWithSpecHash: 큐 file→specHash 매칭으로 verdict에 specHash 채움(미매칭은 빈값)", async () => {
  const { enrichVerdictsWithSpecHash } = await import("../dist/scope.js");
  assert.equal(typeof enrichVerdictsWithSpecHash, "function", "scope.ts에 순수 헬퍼 export");
  const queue = [
    scopeEntry({ file: "src/a.ts", specHash: "h-aaa" }),
    scopeEntry({ file: "src/b.ts", specHash: "h-bbb" }),
  ];
  const verdicts = [sv({ file: "src/a.ts" }), sv({ file: "src/b.ts" }), sv({ file: "src/unknown.ts" })];
  const out = enrichVerdictsWithSpecHash(verdicts, queue);
  assert.equal(out[0].specHash, "h-aaa");
  assert.equal(out[1].specHash, "h-bbb");
  assert.equal(out[2].specHash, "", "큐에 없는 파일은 빈값(거짓 상관 금지)");
  assert.equal(verdicts[0].specHash, undefined, "입력 배열 비변이(순수)");
});

test("logScopeVerdicts: verdict.specHash를 scope 이벤트에 기록(조인키 충전, 미지정은 기존 '')", () => {
  const cwd = tmpCwd();
  try {
    logScopeVerdicts(cwd, "sess-j", [sv({ specHash: "h-join" }), sv({ file: "src/b.ts" })], {
      contextMode: "grep",
      transport: "api",
      specPresent: true,
    });
    const events = parseEvents(readFileSync(join(cwd, ".gbc", "events.jsonl"), "utf8"));
    assert.equal(events.length, 2);
    assert.equal(events[0].specHash, "h-join", "큐잉 시점 specHash가 이벤트에 실림");
    assert.equal(events[1].specHash, "", "specHash 없는 verdict는 기존 규약('') 유지");
    assert.equal(events[0].session, "sess-j", "session×specHash 조인쌍 성립");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("computeMetrics: scope 롤업(파급반경 broken·사다리 걸림·degraded 집계)", () => {
  const events = parseEvents(
    [
      JSON.stringify({ at: "t1", session: "s", specHash: "", kind: "scope", axisA: "broken", rung: "none", degraded: false }),
      JSON.stringify({ at: "t2", session: "s", specHash: "", kind: "scope", axisA: "ok", rung: "rung2", degraded: false }),
      JSON.stringify({ at: "t3", session: "s", specHash: "", kind: "scope", axisA: "unknown", rung: "unknown", degraded: true }),
      JSON.stringify({ at: "t4", session: "s", specHash: "h", kind: "gate", tool: "Edit", decision: "pass" }),
    ].join("\n"),
  );
  const m = computeMetrics(events);
  assert.equal(m.scope.total, 3, "scope 이벤트만 집계(gate 제외)");
  assert.equal(m.scope.rippleBroken, 1);
  assert.equal(m.scope.rungHits, 1);
  assert.equal(m.scope.degraded, 1);
});

// ===== ST1 (0.5.3 W2): buildCliInvocation — CLI 폴백 stdin 통일 =====
// 동적 user(diff·spec)는 stdin으로, argv엔 정적 데이터만 — /proc/*/cmdline 노출 차단.

test("buildCliInvocation: 동적 user는 stdin에만 실리고 argv에 없다", () => {
  const user = "[현재 편집] rm -rf $(secret) `whoami` 매우 긴 diff 본문";
  const inv = buildCliInvocation("SYSTEM", user, "claude-haiku-4-5");
  assert.equal(inv.stdin, user);
  assert.ok(!inv.argv.some((a) => a.includes(user)), "user가 argv에 노출되면 안 됨");
  assert.ok(!inv.argv.some((a) => a.includes("whoami")), "user 부분 문자열도 argv 금지");
});

test("buildCliInvocation: 정적 system은 --append-system-prompt argv로 유지", () => {
  const inv = buildCliInvocation("GATE_SYS_PROMPT", "user", "claude-haiku-4-5");
  const i = inv.argv.indexOf("--append-system-prompt");
  assert.ok(i >= 0, "--append-system-prompt 플래그 존재");
  assert.equal(inv.argv[i + 1], "GATE_SYS_PROMPT");
});

test("buildCliInvocation: -p는 프롬프트 인자 없이 단독(다음 원소는 플래그)", () => {
  const inv = buildCliInvocation("S", "U", "claude-haiku-4-5");
  const i = inv.argv.indexOf("-p");
  assert.ok(i >= 0, "-p 존재");
  assert.ok(String(inv.argv[i + 1] ?? "--").startsWith("--"), "-p 뒤는 프롬프트가 아닌 플래그");
});

test("buildCliInvocation: 모델은 safeModel 화이트리스트 경유(메타문자→기본모델)", () => {
  const inv = buildCliInvocation("S", "U", "evil;model$(x)");
  const i = inv.argv.indexOf("--model");
  assert.equal(inv.argv[i + 1], "claude-haiku-4-5");
  const ok = buildCliInvocation("S", "U", "claude-sonnet-4-6");
  assert.equal(ok.argv[ok.argv.indexOf("--model") + 1], "claude-sonnet-4-6");
});

test("buildCliInvocation: --output-format json 유지(기존 파싱 계약 보존)", () => {
  const inv = buildCliInvocation("S", "U", "claude-haiku-4-5");
  const i = inv.argv.indexOf("--output-format");
  assert.equal(inv.argv[i + 1], "json");
});

// ===== ST2 (0.5.3): version-check latest semver 형식 검증 =====
// 캐시 파일 변조 시 비-semver 문자열이 안내 문구(systemMessage)에 실리지 않게 읽기 지점에서 차단.

test("isValidVersion: 유효 semver는 true", () => {
  for (const v of ["0.5.2", "10.20.30", "1.0.0-rc.1", "1.2.3+build.5"]) {
    assert.equal(isValidVersion(v), true, v);
  }
});

test("isValidVersion: 비-semver·인젝션형은 false", () => {
  for (const v of ["", "abc", "1.2", "1.2.3.4", "9.9.9 <script>", "9.9.9;rm -rf", "9.9.9\n악성", " 1.2.3"]) {
    assert.equal(isValidVersion(v), false, JSON.stringify(v));
  }
});

test("readVersionCache: latest가 비-semver면 캐시 무효(null)", () => {
  const home = tmp();
  try {
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeVersionCache({ latest: "9.9.9 <script>alert(1)</script>", checkedAt: 12345 }, home);
    assert.equal(readVersionCache(home), null, "변조 latest는 읽기 지점에서 무효");
    writeVersionCache({ latest: "9.9.9", checkedAt: 12345 }, home);
    assert.ok(readVersionCache(home), "정상 latest는 그대로 유효");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ===== ST3 (0.5.3): spec.archive 보존상한 =====
// 아카이브 무기한 누적(0.4.2 S2 Warning) 차단 — 최신 keep개만 보존, 오래된 것부터 삭제.

test("pruneSpecArchive: 상한 초과 시 오래된 파일부터 삭제(최신 keep개 보존)", () => {
  const dir = tmp();
  try {
    // 파일명 = <hash16>-<stamp>.md — hash가 시간순과 무관함을 드러내는 배치(늦은 stamp가 앞 hash).
    const names = [
      "aaaaaaaaaaaaaaaa-2026-07-02T03-00-00-000Z.md", // 최신
      "ffffffffffffffff-2026-07-01T01-00-00-000Z.md", // 가장 오래됨
      "bbbbbbbbbbbbbbbb-2026-07-01T02-00-00-000Z.md",
    ];
    for (const n of names) writeFileSync(join(dir, n), "x");
    const removed = pruneSpecArchive(dir, 2);
    assert.deepEqual(removed, ["ffffffffffffffff-2026-07-01T01-00-00-000Z.md"]);
    assert.ok(!existsSync(join(dir, names[1])), "가장 오래된 파일 삭제됨");
    assert.ok(existsSync(join(dir, names[0])) && existsSync(join(dir, names[2])), "최신 2개 보존");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneSpecArchive: 상한 이내·디렉토리 없음은 no-op(빈 배열)", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "aaaaaaaaaaaaaaaa-2026-07-02T03-00-00-000Z.md"), "x");
    assert.deepEqual(pruneSpecArchive(dir, 2), []);
    assert.deepEqual(pruneSpecArchive(join(dir, "없는곳"), 2), [], "디렉토리 부재 fail-silent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archiveSpec: 아카이브 후 보존상한 자동 적용(GBC_ARCHIVE_KEEP)", () => {
  const dir = tmp();
  const prev = process.env.GBC_ARCHIVE_KEEP;
  process.env.GBC_ARCHIVE_KEEP = "1";
  try {
    const arch = join(dir, ".gbc", "spec.archive");
    mkdirSync(arch, { recursive: true });
    writeFileSync(join(arch, "0000000000000000-2020-01-01T00-00-00-000Z.md"), "old");
    addSpecCase(dir, "케이스 A");
    const kept = archiveSpec(dir);
    assert.ok(kept, "아카이브 수행됨");
    const files = readdirSync(arch);
    assert.equal(files.length, 1, "keep=1 → 방금 아카이브만 남음");
    assert.ok(!files.includes("0000000000000000-2020-01-01T00-00-00-000Z.md"));
  } finally {
    if (prev === undefined) delete process.env.GBC_ARCHIVE_KEEP;
    else process.env.GBC_ARCHIVE_KEEP = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneSpecArchive: 비정형 파일명(.md)은 정렬·삭제 대상에서 제외(보존)", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "pre-0.4.2-manual-note.md"), "수동 메모");
    writeFileSync(join(dir, "aaaaaaaaaaaaaaaa-2026-07-02T03-00-00-000Z.md"), "x");
    writeFileSync(join(dir, "bbbbbbbbbbbbbbbb-2026-07-01T01-00-00-000Z.md"), "x");
    const removed = pruneSpecArchive(dir, 1);
    assert.deepEqual(removed, ["bbbbbbbbbbbbbbbb-2026-07-01T01-00-00-000Z.md"]);
    assert.ok(existsSync(join(dir, "pre-0.4.2-manual-note.md")), "비정형 파일은 keep 계산과 무관하게 보존");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
