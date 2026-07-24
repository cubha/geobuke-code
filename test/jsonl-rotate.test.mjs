// 0.10.6 A3(TDD) — jsonl 1세대 로테이션 공용화. extraction.ts(0.7.0)가 처음 도입한 패턴(상한 이상이면
// .jsonl→.1.jsonl, 기존 .1은 덮어씀)을 metrics.ts(events.jsonl)도 쓰게 되며 공용 추출한다. 이 로직은
// 지금까지 extraction.ts appendExtraction 내부에 인라인돼 있어 직접 단위테스트가 없었다 — 이번에
// 추출하며 처음으로 커버한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateJsonlIfOversize } from "../dist/jsonl-rotate.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "gbc-jsonl-rotate-test-"));
}

test("rotateJsonlIfOversize: 상한 미만이면 로테이션하지 않는다", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "small");
    rotateJsonlIfOversize(path, 1024);
    assert.equal(readFileSync(path, "utf8"), "small");
    assert.equal(existsSync(join(dir, "events.1.jsonl")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateJsonlIfOversize: 상한 이상이면 .jsonl→.1.jsonl로 이름을 바꾼다(원본 경로는 비워짐)", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "events.jsonl");
    const rotatedPath = join(dir, "events.1.jsonl");
    writeFileSync(path, "x".repeat(20));
    rotateJsonlIfOversize(path, 10);
    assert.equal(existsSync(path), false);
    assert.equal(readFileSync(rotatedPath, "utf8"), "x".repeat(20));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateJsonlIfOversize: 기존 .1 세대가 있으면 덮어쓴다(1세대만 유지)", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "events.jsonl");
    const rotatedPath = join(dir, "events.1.jsonl");
    writeFileSync(rotatedPath, "old-generation");
    writeFileSync(path, "x".repeat(20));
    rotateJsonlIfOversize(path, 10);
    assert.equal(readFileSync(rotatedPath, "utf8"), "x".repeat(20));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateJsonlIfOversize: 파일이 없으면(최초 기록 전) 조용히 아무 것도 하지 않는다", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "events.jsonl");
    assert.doesNotThrow(() => rotateJsonlIfOversize(path, 10));
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
