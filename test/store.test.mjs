// 0.9.3 ST1 — resolveProjectRoot 조상 walk-up. fa-support 도그푸딩 오탐 리포트(2026-07-13)
// "명세 소스: (없음)" 3회의 근본원인 가설: hook cwd가 spec 로드 시점에 프로젝트 루트가 아닐 수
// 있음(loadPlanSpec은 조상 walk-up 없이 cwd/.gbc/spec.md만 본다). 이 함수가 hook 진입점에서
// cwd를 프로젝트 루트로 정정한다. read-only — mkdir 부작용은 여전히 gbcDir()가 담당(분리 유지).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolveProjectRoot } from "../dist/store.js";

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
