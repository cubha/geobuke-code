// 0.10.0 A3b ST4 — judge.ts CLI 트랜스포트 spawn cwd 명시.
// LLM 재유입 경로 2(braintrust R2 [中]): TUI가 여러 repo를 다루게 되면서, judgeViaCli의
// spawn("claude", ...)가 cwd 미지정이면 TUI 프로세스 자신의 cwd를 상속한다 — 판정 대상 repo와
// 무관한 프로젝트 컨텍스트를 CLI가 로드해 판정이 오염될 수 있다. 여기서는 spawn()에 실제로
// cwd가 전달되는지를 fake spawnFn 주입으로 단정한다(진짜 claude 바이너리 호출 없이).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runClaudeCli, judgeViaCli, judgeViaCliWin, resolveNoMemorySettingsPath } from "../dist/judge.js";

/** child_process.spawn 최소 대역 — options만 기록하고 즉시 성공 종료(비동기 큐잉으로 실제 이벤트 흐름 모사).
 *  claude -p --output-format json 실제 응답 형상({"result": "<model 응답 문자열>"})을 그대로 흉내낸다. */
function makeFakeSpawn(stdout = '{"result":"ok"}') {
  const calls = [];
  const spawnFn = (cmd, argv, options) => {
    calls.push({ cmd, argv, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", stdout);
      child.emit("close", 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

test("runClaudeCli: opts.cwd가 spawn() 세 번째 인자(options.cwd)로 그대로 전달된다", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const out = await runClaudeCli({ argv: ["-p"], stdin: "u" }, { cwd: "/repo/target", spawnFn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, "/repo/target");
  assert.equal(out, "ok");
});

test("runClaudeCli: opts.cwd 미지정이면 spawn options.cwd는 undefined(기존 동작 — 프로세스 cwd 상속, 회귀 없음)", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  await runClaudeCli({ argv: ["-p"], stdin: "u" }, { spawnFn });
  assert.equal(calls[0].options.cwd, undefined);
});

test("runClaudeCli: shell:true 경로(win32)에서도 cwd가 함께 전달된다", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  await runClaudeCli({ argv: ["-p"], stdin: "u" }, { shell: true, cwd: "/repo/win", spawnFn });
  assert.equal(calls[0].options.shell, true);
  assert.equal(calls[0].options.cwd, "/repo/win");
});

test("judgeViaCli(POSIX 경로): cwd 인자가 runClaudeCli까지 전달된다", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  await judgeViaCli("SYS", "USER", "claude-haiku-4-5", "/repo/posix", spawnFn);
  assert.equal(calls[0].options.cwd, "/repo/posix");
});

test("judgeViaCliWin: cwd 인자가 runClaudeCli까지 전달된다(shell:true 유지)", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  await judgeViaCliWin("SYS", "USER", "claude-haiku-4-5", "/repo/win2", spawnFn, null);
  assert.equal(calls[0].options.cwd, "/repo/win2");
  assert.equal(calls[0].options.shell, true);
});

// ===== 0.10.0 A3b 실기검증 이슈①(격리 렌즈 신규발견+실측 확정, 2026-07-16): judge CLI 폴백이
// 판정대상 repo의 auto-memory를 읽어 "이미 완료됐다"는 편향 답변을 만든다. judgeViaCli/
// judgeViaCliWin의 마지막 인자(settingsPath)가 --settings 플래그 배선을 제어한다(DI seam —
// 실제 파일 I/O 없이 순수 문자열 주입으로 테스트). =====

test("judgeViaCli(POSIX): settingsPath가 있으면 argv에 --settings로 배선된다", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  await judgeViaCli("SYS", "USER", "claude-haiku-4-5", "/repo/posix", spawnFn, "/home/u/.gbc/no-memory-settings.json");
  const i = calls[0].argv.indexOf("--settings");
  assert.ok(i >= 0, "--settings 플래그 존재");
  assert.equal(calls[0].argv[i + 1], "/home/u/.gbc/no-memory-settings.json");
});

test("judgeViaCli(POSIX): settingsPath가 null이면 --settings 플래그를 생략한다(fail-open)", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  await judgeViaCli("SYS", "USER", "claude-haiku-4-5", "/repo/posix", spawnFn, null);
  assert.ok(!calls[0].argv.includes("--settings"));
});

test("judgeViaCliWin: settingsPath가 있으면 argv에 --settings로 배선된다(shell:true 경로에서도 따옴표 없는 경로 문자열이라 안전)", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  await judgeViaCliWin("SYS", "USER", "claude-haiku-4-5", "/repo/win2", spawnFn, "C:\\Users\\u\\.gbc\\no-memory-settings.json");
  const i = calls[0].argv.indexOf("--settings");
  assert.ok(i >= 0, "--settings 플래그 존재");
  assert.equal(calls[0].argv[i + 1], "C:\\Users\\u\\.gbc\\no-memory-settings.json");
});

test("judgeViaCli: settingsPath 미지정 시 resolveNoMemorySettingsPath()가 기본값으로 호출된다(실제 spawn 없이 argv만 확인)", async () => {
  // 실제 홈 디렉토리 I/O가 일어나는 경로 — resolveNoMemorySettingsPath 자체의 성공/실패와 무관하게
  // (성공하면 경로 문자열, 실패하면 null) judgeViaCli가 그 결과를 그대로 buildCliInvocation에
  // 전달하기만 하면 된다는 걸 spawnFn으로 관측한다.
  const { spawnFn, calls } = makeFakeSpawn();
  await judgeViaCli("SYS", "USER", "claude-haiku-4-5", "/repo/default", spawnFn);
  const path = resolveNoMemorySettingsPath();
  const i = calls[0].argv.indexOf("--settings");
  if (path === null) {
    assert.equal(i, -1, "resolveNoMemorySettingsPath()가 null이면 --settings 미포함");
  } else {
    assert.ok(i >= 0);
    assert.equal(calls[0].argv[i + 1], path);
  }
});

test("resolveNoMemorySettingsPath: 파일이 없으면 mkdir+write로 생성하고 경로를 반환한다", () => {
  const written = {};
  const path = resolveNoMemorySettingsPath({
    homeDir: "/fake/home",
    exists: (p) => Object.prototype.hasOwnProperty.call(written, p),
    mkdir: () => {},
    writeFile: (p, content) => {
      written[p] = content;
    },
  });
  assert.equal(path, "/fake/home/.gbc/no-memory-settings.json");
  assert.ok(written[path], "파일이 실제로 쓰였다");
  assert.deepEqual(JSON.parse(written[path]), { autoMemoryEnabled: false });
});

test("resolveNoMemorySettingsPath: 파일이 이미 있으면 다시 쓰지 않는다(멱등)", () => {
  let writeCount = 0;
  const path = resolveNoMemorySettingsPath({
    homeDir: "/fake/home",
    exists: () => true,
    mkdir: () => {},
    writeFile: () => {
      writeCount++;
    },
  });
  assert.ok(path);
  assert.equal(writeCount, 0);
});

test("resolveNoMemorySettingsPath: mkdir/writeFile이 던지면 null을 반환한다(fail-open — claude CLI가 부재 settings 파일에 하드 에러하므로, 없는 경로를 억지로 넘기지 않는다)", () => {
  const path = resolveNoMemorySettingsPath({
    homeDir: "/fake/home",
    exists: () => false,
    mkdir: () => {
      throw new Error("EACCES");
    },
    writeFile: () => {},
  });
  assert.equal(path, null);
});
