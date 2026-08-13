// !bash — TUI 입력창에서 사람이 직접 셸 명령을 실행하는 경로(0.12.3 Task C). 모델이 호출하는
// 도구 경로가 아니라 사람이 직접 타이핑하는 입력이라 evaluateGate(judge 판정)를 전혀 경유하지
// 않는다(사람 직접입력은 애초 게이트 범위 밖, 2026-08-03 제품결정 확정). argv 배열 spawn
// 필수(셸 문자열 통짜 실행 금지) — scope.ts realGrep·install.ts buildPreCommand와 동일 안전기준.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { parseBangInput, runBangCommand, formatBangOutput, BANG_TIMEOUT_MS, BANG_MAX_OUTPUT } from "../dist/tui/bang.js";

// ===== parseBangInput — 파서(순수) =====

test("parseBangInput: '!'로 시작 안 하면 not-bang(기존 프롬프트 경로)", () => {
  assert.deepEqual(parseBangInput("ls -la"), { kind: "not-bang" });
  assert.deepEqual(parseBangInput(""), { kind: "not-bang" });
});

test("parseBangInput: '!'만 입력하면 empty", () => {
  assert.deepEqual(parseBangInput("!"), { kind: "empty" });
  assert.deepEqual(parseBangInput("!   "), { kind: "empty" });
});

test("parseBangInput: 단순 명령+인자 분리", () => {
  const r = parseBangInput("!ls -la /tmp");
  assert.equal(r.kind, "command");
  assert.equal(r.cmd, "ls");
  assert.deepEqual(r.args, ["-la", "/tmp"]);
});

test("parseBangInput: 여러 공백은 하나의 구분자로 접힌다", () => {
  const r = parseBangInput("!echo   a    b");
  assert.equal(r.kind, "command");
  assert.equal(r.cmd, "echo");
  assert.deepEqual(r.args, ["a", "b"]);
});

test("parseBangInput: 큰따옴표 안 공백은 하나의 인자로 묶인다", () => {
  const r = parseBangInput('!echo "hello world" next');
  assert.equal(r.kind, "command");
  assert.deepEqual(r.args, ["hello world", "next"]);
});

test("parseBangInput: 작은따옴표 안 공백도 하나의 인자로 묶인다", () => {
  const r = parseBangInput("!echo 'a b c' d");
  assert.equal(r.kind, "command");
  assert.deepEqual(r.args, ["a b c", "d"]);
});

test("parseBangInput: 백슬래시 이스케이프로 리터럴 문자 포함", () => {
  const r = parseBangInput('!echo a\\ b');
  assert.equal(r.kind, "command");
  assert.deepEqual(r.args, ["a b"]);
});

test("parseBangInput: 따옴표 안에서는 셸 변수 확장이 없다(셸이 없으므로) — 원문 그대로 보존", () => {
  const r = parseBangInput('!echo "$HOME"');
  assert.deepEqual(r.args, ["$HOME"]); // 확장 안 됨, 리터럴 텍스트 그대로
});

test("parseBangInput: 따옴표 미종결은 error(조용히 봉합하지 않는다)", () => {
  const r1 = parseBangInput('!echo "unterminated');
  assert.equal(r1.kind, "error");
  assert.match(r1.reason, /따옴표/);
  const r2 = parseBangInput("!echo 'unterminated");
  assert.equal(r2.kind, "error");
});

test("parseBangInput: 개행 포함은 여러 줄 명령 미지원 error", () => {
  const r = parseBangInput("!echo a\necho b");
  assert.equal(r.kind, "error");
  assert.match(r.reason, /여러 줄/);
});

// ===== runBangCommand — 러너(I/O, 주입 seam) =====

test("runBangCommand: argv 배열로 spawn하며 shell:false(셸 문자열 통짜 실행 금지)", async () => {
  let spawnOpts;
  const fakeSpawn = (cmd, args, opts) => {
    spawnOpts = { cmd, args, opts };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from("ok\n"));
      child.emit("close", 0);
    });
    return child;
  };
  const r = await runBangCommand("echo", ["hi"], { cwd: "/tmp", spawnFn: fakeSpawn });
  assert.equal(spawnOpts.cmd, "echo");
  assert.deepEqual(spawnOpts.args, ["hi"]);
  assert.equal(spawnOpts.opts.shell, false);
  assert.equal(spawnOpts.opts.cwd, "/tmp");
  assert.equal(spawnOpts.opts.stdio[0], "ignore", "stdin은 ignore — 대화형 명령이 매달리지 않게");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "ok\n");
});

test("runBangCommand: 실제 node로 정상 실행(주입 없이) — 종료코드·출력 확인", async () => {
  const r = await runBangCommand("node", ["-e", "console.log('hello-bang')"], { cwd: process.cwd() });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello-bang/);
  assert.equal(r.timedOut, false);
  assert.equal(r.truncated, false);
});

test("runBangCommand: 존재하지 않는 명령은 spawnError로 반환(throw 금지 — TUI를 죽이지 않는다)", async () => {
  const r = await runBangCommand("this-command-does-not-exist-xyz", [], { cwd: process.cwd() });
  assert.ok(r.spawnError, "spawnError가 설정돼야 함");
  assert.equal(r.code, null);
});

test("runBangCommand: 타임아웃 시 kill하고 timedOut=true", async () => {
  let killed = false;
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; };
    // close를 절대 emit하지 않음 — 타임아웃만 발동
    return child;
  };
  const r = await runBangCommand("sleep", ["999"], { cwd: "/tmp", timeoutMs: 20, spawnFn: fakeSpawn });
  assert.equal(r.timedOut, true);
  assert.equal(killed, true);
});

test("runBangCommand: 누적 출력이 maxBytes를 넘으면 kill하고 truncated=true", async () => {
  let killed = false;
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; };
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from("x".repeat(100)));
    });
    return child;
  };
  const r = await runBangCommand("yes", [], { cwd: "/tmp", maxBytes: 50, spawnFn: fakeSpawn });
  assert.equal(r.truncated, true);
  assert.equal(killed, true);
});

test("BANG_TIMEOUT_MS / BANG_MAX_OUTPUT: 합리적 기본 상한 상수", () => {
  assert.equal(BANG_TIMEOUT_MS, 30_000);
  assert.equal(BANG_MAX_OUTPUT, 64 * 1024);
});

// ===== formatBangOutput — 포맷터(순수) =====

test("formatBangOutput: 정상 종료(0)는 종료코드 고지 없이 stdout만", () => {
  const lines = formatBangOutput({ code: 0, stdout: "line1\nline2\n", stderr: "", timedOut: false, truncated: false });
  assert.deepEqual(lines.filter((l) => l.includes("line")), ["line1", "line2"]);
  assert.ok(!lines.some((l) => l.includes("종료코드")));
});

test("formatBangOutput: 비정상 종료코드는 경고 한 줄 고지", () => {
  const lines = formatBangOutput({ code: 1, stdout: "", stderr: "err\n", timedOut: false, truncated: false });
  assert.ok(lines.some((l) => l.includes("종료코드") && l.includes("1")));
});

test("formatBangOutput: timedOut/truncated/spawnError 각각 고지 문구", () => {
  assert.ok(formatBangOutput({ code: null, stdout: "", stderr: "", timedOut: true, truncated: false }).some((l) => l.includes("타임아웃")));
  assert.ok(formatBangOutput({ code: null, stdout: "", stderr: "", timedOut: false, truncated: true }).some((l) => l.includes("생략") || l.includes("절단")));
  assert.ok(
    formatBangOutput({ code: null, stdout: "", stderr: "", timedOut: false, truncated: false, spawnError: "ENOENT" }).some((l) => l.includes("ENOENT")),
  );
});

test("formatBangOutput: ANSI 이스케이프·제어문자를 스트립한다(ink 스크롤백 오염 방지)", () => {
  const lines = formatBangOutput({ code: 0, stdout: "\x1b[31mred\x1b[0m text\r\n", stderr: "", timedOut: false, truncated: false });
  const joined = lines.join("\n");
  assert.doesNotMatch(joined, /\x1b/);
  assert.match(joined, /red text|redtext|red.*text/);
});

test("formatBangOutput: 줄 수 상한 초과 시 head+tail만 남기고 생략 표시", () => {
  const stdout = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
  const lines = formatBangOutput({ code: 0, stdout, stderr: "", timedOut: false, truncated: false }, { maxLines: 20 });
  assert.ok(lines.length < 500);
  assert.ok(lines.some((l) => l.includes("생략")));
  assert.ok(lines.some((l) => l.includes("line0")), "head 보존");
  assert.ok(lines.some((l) => l.includes("line499")), "tail 보존");
});

// ── 0.12.3 ship 보안검토 후속(S2) ─────────────────────────────────────────────
// `!cat .env`·`!env`류 출력이 스크롤백에 그대로 들어가고, 크래시 시 그 스크롤백이
// `.gbc/crash-dump.txt`에 원문으로 기록된다(app.tsx:429). bang은 이 sink로 흘러드는
// **신규 데이터 소스**라 여기서 마스킹한다 — applied.ts summarizeAppliedEdit과 같은
// 규율(마스킹은 소스에서 1회, 절단보다 먼저).
test("formatBangOutput: 출력의 시크릿을 마스킹한다(크래시 덤프 평문 노출 차단)", () => {
  const out = formatBangOutput({
    code: 0,
    stdout: 'ANTHROPIC_API_KEY=sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF\nGITHUB_TOKEN=ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII\n',
    stderr: "",
    timedOut: false,
    truncated: false,
  }).join("\n");
  assert.ok(!out.includes("sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF"), "Anthropic 키가 평문으로 남았다");
  assert.ok(!out.includes("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII"), "GitHub 토큰이 평문으로 남았다");
  assert.match(out, /REDACTED/);
});

test("formatBangOutput: 마스킹은 줄수 절단보다 먼저 적용된다(절단이 마스킹을 건너뛰지 않는다)", () => {
  const lines = Array.from({ length: 300 }, (_, i) =>
    i === 150 ? "KEY=sk-ant-api03-MIDDLEMIDDLEMIDDLEMIDD" : `line${i}`,
  );
  const out = formatBangOutput(
    { code: 0, stdout: lines.join("\n"), stderr: "", timedOut: false, truncated: false },
    { maxLines: 400 },
  ).join("\n");
  assert.ok(!out.includes("sk-ant-api03-MIDDLEMIDDLEMIDDLEMIDD"));
});
