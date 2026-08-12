// gbc doctor — stray(화석) .gbc 마커 탐지·격리 (0.12.2 SubTask5).
// stray = 형제 .claude/skills/gate/가 없는 .gbc(gbc init을 거친 적 없다는 구조 판별,
// store.ts isRealGateRoot와 동일 술어). daily-news-dispatch/fa-support/codebase-viz 실측에서
// 13곳 발견됐다 — 검출은 하되 shadow 이벤트를 코퍼스에 병합하지 않는다(과거 지표 소급오염 방지).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStrayGbcMarkers, quarantineStrayMarkers } from "../dist/doctor.js";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "gbc-doctor-test-"));
}

function makeRealRoot(dir) {
  mkdirSync(join(dir, ".claude", "skills", "gate"), { recursive: true });
  mkdirSync(join(dir, ".gbc"), { recursive: true });
}

function makeStray(dir) {
  mkdirSync(join(dir, ".gbc"), { recursive: true });
}

test("findStrayGbcMarkers: 형제 gate스킬 없는 하위 .gbc를 찾는다", () => {
  const root = tmpRoot();
  try {
    makeRealRoot(root);
    const sub = join(root, "packages", "api");
    makeStray(sub);
    const found = findStrayGbcMarkers(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].dir, sub);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findStrayGbcMarkers: 루트 자신이 real이면 잡지 않는다", () => {
  const root = tmpRoot();
  try {
    makeRealRoot(root);
    assert.deepEqual(findStrayGbcMarkers(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findStrayGbcMarkers: 여러 하위 stray를 전부 찾는다(fa-support류 다건)", () => {
  const root = tmpRoot();
  try {
    makeRealRoot(root);
    const a = join(root, "apps", "admin");
    const b = join(root, "apps", "api", "src", "modules", "mail");
    makeStray(a);
    makeStray(b);
    const found = findStrayGbcMarkers(root).map((m) => m.dir).sort();
    assert.deepEqual(found, [a, b].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findStrayGbcMarkers: node_modules·.git 하위는 뒤지지 않는다(성능·오탐 방지)", () => {
  const root = tmpRoot();
  try {
    makeRealRoot(root);
    makeStray(join(root, "node_modules", "some-pkg"));
    makeStray(join(root, ".git", "modules", "x"));
    assert.deepEqual(findStrayGbcMarkers(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findStrayGbcMarkers: 이미 격리된 .gbc-quarantine-* 디렉토리는 재탐지하지 않는다(멱등)", () => {
  const root = tmpRoot();
  try {
    makeRealRoot(root);
    mkdirSync(join(root, ".gbc-quarantine-2026-08-12", "sub_.gbc"), { recursive: true });
    assert.deepEqual(findStrayGbcMarkers(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findStrayGbcMarkers: 심링크로 연결된 하위 디렉토리는 따라가지 않는다(탈출 방지)", () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  try {
    makeRealRoot(root);
    // 밖(outside)에 stray .gbc를 심어두고, root 안에서 심링크로 그 디렉토리를 가리키게 한다.
    // 워크스페이스 밖을 심링크로 스캔하면 안 되므로, 이 심링크 엔트리 자체가 순회 대상에서 빠져야 한다.
    makeStray(outside);
    symlinkSync(outside, join(root, "linked-out"), "dir");
    assert.deepEqual(findStrayGbcMarkers(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("quarantineStrayMarkers: 삭제가 아니라 .gbc-quarantine-<stamp>/로 이동(포렌식 보존)", () => {
  const root = tmpRoot();
  try {
    makeRealRoot(root);
    const sub = join(root, "local-agent");
    makeStray(sub);
    writeFileSync(join(sub, ".gbc", "events.jsonl"), '{"at":"t1"}\n', "utf8");
    const found = findStrayGbcMarkers(root);
    const moved = quarantineStrayMarkers(root, found, { stamp: "2026-08-12" });
    assert.equal(moved.length, 1);
    assert.equal(existsSync(join(sub, ".gbc")), false, "원래 자리에서 사라져야 한다");
    assert.equal(existsSync(moved[0].quarantinedPath), true, "격리 위치에 보존돼야 한다");
    assert.match(
      readdirSync(join(root, ".gbc-quarantine-2026-08-12")).join(","),
      /local-agent/,
    );
    // 내용까지 그대로 보존됐는지 확인(단순 삭제가 아니라 진짜 이동임을 실증)
    assert.match(
      readFileSync(join(moved[0].quarantinedPath, "events.jsonl"), "utf8"),
      /"at":"t1"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quarantineStrayMarkers: 격리 후 재탐지하면 0건(멱등 — 무한 재격리 없음)", () => {
  const root = tmpRoot();
  try {
    makeRealRoot(root);
    const sub = join(root, "local-agent");
    makeStray(sub);
    const found = findStrayGbcMarkers(root);
    quarantineStrayMarkers(root, found, { stamp: "2026-08-12" });
    assert.deepEqual(findStrayGbcMarkers(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
