import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { normalizeEdit, isGatedTool } from "../dist/normalize.js";
import { parseVerdict, buildUserMessage, failOpenVerdict } from "../dist/judge.js";
import { computeSpecHash, loadPlanSpec } from "../dist/spec.js";
import {
  addDefer,
  activeDeferItems,
  resolveDefer,
  unresolvedDefers,
  loadDefers,
  startDefer,
  reopenDefer,
} from "../dist/defer.js";
import { isGated, markGated, resetGate, loadState } from "../dist/state.js";
import { addSpecCase, readSpecCases, clearSpec } from "../dist/spec.js";
import {
  buildBlockReason,
  shouldCacheVerdict,
  buildSessionStartHint,
  buildStopReminder,
  buildCrossRepoHint,
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
  writeVersionCache,
  shouldRefreshCache,
} from "../dist/version.js";
import { serializeEvent, parseEvents, computeMetrics, logEvent, tagEventsWithRepo } from "../dist/metrics.js";
import { goldenCaseId, diffVerdict, upsertGolden, summarizeReplay } from "../dist/golden.js";
import { resolveApiKey, safeModel } from "../dist/judge.js";
import { normalizeCase, MAX_CASE } from "../dist/text.js";
import { isStopHintMuted, setStopHintMuted } from "../dist/config.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const env = { ...process.env, GBC_NO_UPDATE_NOTICE: "1" };
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
  } finally {
    rmSync(proj, { recursive: true, force: true });
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
