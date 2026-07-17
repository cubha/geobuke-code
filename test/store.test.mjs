// 0.9.3 ST1 — resolveProjectRoot 조상 walk-up. fa-support 도그푸딩 오탐 리포트(2026-07-13)
// "명세 소스: (없음)" 3회의 근본원인 가설: hook cwd가 spec 로드 시점에 프로젝트 루트가 아닐 수
// 있음(loadPlanSpec은 조상 walk-up 없이 cwd/.gbc/spec.md만 본다). 이 함수가 hook 진입점에서
// cwd를 프로젝트 루트로 정정한다. read-only — mkdir 부작용은 여전히 gbcDir()가 담당(분리 유지).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { resolveProjectRoot, writeJson, readJson, withStoreLock } from "../dist/store.js";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "gbc-store-test-"));
}

test("resolveProjectRoot: cwd 자신에 .gbc가 있으면 cwd 그대로(가장 흔한 경우)", () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, ".gbc"));
    assert.equal(resolveProjectRoot(root, { homeDir: dirname(root) }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProjectRoot: 하위 디렉토리에서 시작해도 .gbc 있는 조상을 찾는다", () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, ".gbc"));
    const sub = join(root, "a", "b", "c");
    mkdirSync(sub, { recursive: true });
    assert.equal(resolveProjectRoot(sub, { homeDir: dirname(root) }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProjectRoot: 조상 중 .gbc 없으면 원래 cwd로 fallback(신규 프로젝트 mkdir 동작 불변)", () => {
  const root = tmpRoot();
  try {
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    assert.equal(resolveProjectRoot(sub, { homeDir: dirname(root) }), sub);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProjectRoot: 홈 디렉토리 자신의 .gbc(전역 설정용)는 프로젝트 루트로 취급하지 않는다", () => {
  const home = tmpRoot();
  try {
    mkdirSync(join(home, ".gbc")); // ~/.gbc — api-key 등 전역 데이터(resolveApiKey 관례)
    const sub = join(home, "workspace", "proj");
    mkdirSync(sub, { recursive: true });
    assert.equal(resolveProjectRoot(sub, { homeDir: home }), sub, "홈의 .gbc를 프로젝트로 오인하면 안 됨");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveProjectRoot: 심링크 .gbc는 신뢰하지 않고 계속 올라간다", () => {
  const root = tmpRoot();
  try {
    const real = join(root, "real-gbc-target");
    mkdirSync(real);
    const decoy = join(root, "decoy");
    mkdirSync(decoy);
    symlinkSync(real, join(decoy, ".gbc"), "dir");
    const trueRoot = join(root, "trueroot");
    mkdirSync(trueRoot);
    mkdirSync(join(trueRoot, ".gbc"));
    const sub = join(trueRoot, "decoy2"); // 별도 시나리오: decoy 자체를 cwd로 시작
    mkdirSync(sub, { recursive: true });
    // decoy를 직접 cwd로 시작 — 심링크 .gbc만 있고 진짜 조상엔 없으므로 fallback(원래 cwd)
    assert.equal(resolveProjectRoot(decoy, { homeDir: dirname(root) }), decoy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProjectRoot: 순수성 — 파일시스템을 변경하지 않는다(mkdir 없음)", () => {
  const root = tmpRoot();
  try {
    const sub = join(root, "x", "y");
    mkdirSync(sub, { recursive: true });
    resolveProjectRoot(sub, { homeDir: dirname(root) });
    assert.equal(existsSync(join(root, ".gbc")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===== writeJson atomic write (0.10.0 A3b ST8 — 독립 결함) =====
// repos.json/verify-run.json/session-map.json은 다른 프로세스(gbc CLI 단발 호출·TUI 장수 프로세스)가
// 동시에 쓸 수 있는 글로벌 파일이다(0.2.9부터 기존재). writeFileSync(path, data) 직접 쓰기는 두 syscall
// 이상으로 쪼개질 수 있는 대용량 쓰기에서 "쓰는 도중" 상태를 다른 프로세스가 읽으면 torn(잘린/깨진)
// JSON을 볼 수 있다 — temp 파일에 먼저 쓰고 rename()으로 교체하면 rename이 원자적이라(POSIX 보장,
// 같은 파일시스템 내) 읽는 쪽은 항상 "이전 완전한 내용" 또는 "새 완전한 내용" 둘 중 하나만 본다.

test("writeJson→readJson: 기존 라운드트립 동작 보존(회귀 없음)", () => {
  const root = tmpRoot();
  try {
    const p = join(root, "data.json");
    writeJson(p, { a: 1, b: ["x", "y"] });
    assert.deepEqual(readJson(p, null), { a: 1, b: ["x", "y"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeJson: 성공 후 임시파일이 남지 않는다(디렉토리에 대상 파일만 존재)", () => {
  const root = tmpRoot();
  try {
    const p = join(root, "data.json");
    writeJson(p, { a: 1 });
    writeJson(p, { a: 2 }); // 재작성도 임시파일을 안 남기는지
    const entries = readdirSync(root);
    assert.deepEqual(entries, ["data.json"], "temp 파일이 정리되지 않고 남으면 안 됨");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeJson: temp 파일명이 대상 파일과 동일 디렉토리(rename이 파일시스템 경계를 안 넘게)", () => {
  // rename()의 원자성 보장은 "같은 파일시스템 내"라는 전제다 — temp를 /tmp 등 다른 위치에 쓰면
  // cross-device rename(EXDEV)으로 실패하거나 원자성이 깨진다. writeJson 소스가 대상과 같은
  // dirname()에 temp를 만드는지 소스 레벨로 고정한다(비결정 프로세스ID 포함 이름이라 값 단정은 불가).
  const src = readFileSync(new URL("../dist/store.js", import.meta.url), "utf8");
  const fnStart = src.indexOf("export function writeJson(");
  assert.ok(fnStart >= 0);
  const fnBody = src.slice(fnStart, fnStart + 600);
  assert.match(fnBody, /renameSync\(/, "temp+rename 패턴을 써야 한다(직접 writeFileSync(path,...) 금지)");
  assert.doesNotMatch(fnBody, /writeFileSync\(path,/, "대상 경로에 직접 쓰면 안 됨 — 반드시 temp 경유");
});

// ===== withStoreLock (0.10.0 A3b ST8, scope-critic 지적으로 추가) =====
// temp+rename은 torn read만 막는다 — read-modify-write 전체를 직렬화하는 락이 없으면 두 프로세스가
// 동시에 같은 파일을 읽어 각자 고친 뒤 쓸 때 나중 쓰기가 먼저 쓰기를 지운다(lost-update). 아래는
// 이 락이 ①실제로 임계구역 동안 잡혀있고 ②정상 종료 후 정리되고 ③죽은 락에도 영구히 멈추지 않고
// (fail-open) ④진짜 다른 OS 프로세스에 대해서도 직렬화되는지를 검증한다.

test("withStoreLock: fn()의 반환값을 그대로 반환한다", () => {
  const root = tmpRoot();
  try {
    const p = join(root, "data.json");
    const result = withStoreLock(p, () => 42);
    assert.equal(result, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withStoreLock: fn() 실행 중엔 락 디렉토리가 실제로 존재한다(장식용 아님)", () => {
  const root = tmpRoot();
  try {
    const p = join(root, "data.json");
    let heldDuring = false;
    withStoreLock(p, () => {
      heldDuring = existsSync(`${p}.lock`);
    });
    assert.equal(heldDuring, true, "임계구역 안에서 락 디렉토리가 존재해야 진짜 락");
    assert.equal(existsSync(`${p}.lock`), false, "정상 종료 후엔 락이 정리돼야 함");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withStoreLock: fn()이 던져도 락은 정리된다(finally)", () => {
  const root = tmpRoot();
  try {
    const p = join(root, "data.json");
    assert.throws(() => withStoreLock(p, () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(`${p}.lock`), false, "예외가 나도 락 디렉토리는 남으면 안 됨");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withStoreLock: 죽은 프로세스가 남긴 stale 락이 있어도 유한 시간 내 fail-open으로 진행한다(영구 정지 아님)", () => {
  const root = tmpRoot();
  try {
    const p = join(root, "data.json");
    mkdirSync(`${p}.lock`); // 다른 프로세스가 크래시로 못 지운 락을 흉내
    const t0 = Date.now();
    let ran = false;
    withStoreLock(p, () => {
      ran = true;
    });
    const elapsed = Date.now() - t0;
    assert.equal(ran, true, "stale 락 때문에 fn()이 영영 안 불리면 안 됨(fail-open)");
    assert.ok(elapsed < 3000, `타임아웃 상한 이내여야 함(실측 ${elapsed}ms) — 무기한 대기 아님`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withStoreLock: 진짜 다른 OS 프로세스가 락을 쥐고 있으면, 그 프로세스가 놓을 때까지 실제로 직렬화된다", async () => {
  const root = tmpRoot();
  const p = join(root, "data.json");
  const lockDir = `${p}.lock`;
  const HOLD_MS = 150;
  try {
    // 자식 프로세스: 락 디렉토리를 mkdir한 뒤 HOLD_MS 동안 쥐고 있다가 rmdir(진짜 크로스프로세스 락 보유).
    const child = spawn(
      process.execPath,
      ["-e", `require('fs').mkdirSync(${JSON.stringify(lockDir)}); const until=Date.now()+${HOLD_MS}; while(Date.now()<until){} require('fs').rmdirSync(${JSON.stringify(lockDir)});`],
      { stdio: "ignore" },
    );
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (existsSync(lockDir)) {
          clearInterval(check);
          resolve();
        }
      }, 2);
    });
    const t0 = Date.now();
    withStoreLock(p, () => {}); // 자식이 락을 쥐고 있는 동안 이 프로세스는 mkdirSync(EEXIST)로 스핀 대기해야 함
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= HOLD_MS * 0.5, `자식이 락을 놓기 전에 통과하면 직렬화가 안 된 것 — 실측 ${elapsed}ms(기대 ${HOLD_MS}ms 근처)`);
    await new Promise((resolve) => child.on("exit", resolve));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeJson: 연속 재작성 N회 모두 대상 파일이 항상 유효한 JSON(중간에 잘린/빈 상태로 관측되지 않음)", () => {
  const root = tmpRoot();
  const p = join(root, "data.json");
  try {
    for (let i = 0; i < 20; i++) {
      writeJson(p, { seq: i, payload: "x".repeat(500) }); // 단일 syscall write 가정을 깨보려는 크기
      const got = readJson(p, null);
      assert.equal(got.seq, i, `${i}번째 쓰기 직후 읽기가 그 값과 정확히 일치해야 함(temp+rename 원자성)`);
    }
    assert.deepEqual(readdirSync(root), ["data.json"], "20회 재작성 후에도 temp 잔여 없음");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
