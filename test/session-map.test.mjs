// 0.10.0 A3b ST7 — repoId→sessionId 맵 영속(src/session-map.ts).
// TUI 재시작 후 탭 복귀 시 resume 후보로 쓸 "이 repo에서 마지막으로 쓰던 session_id"를 홈
// 디렉토리(~/.gbc/session-map.json)에 저장한다 — repos.json/verify-run.json과 동위(store.ts
// gbcDir(homedir()) 관례). homeDir 주입으로 실제 홈을 건드리지 않고 테스트한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLastSessionId, setLastSessionId, clearLastSessionId } from "../dist/session-map.js";

function tmpHome() {
  return mkdtempSync(join(tmpdir(), "gbc-session-map-test-"));
}

test("getLastSessionId: 저장된 적 없는 repoId는 null", () => {
  const home = tmpHome();
  try {
    assert.equal(getLastSessionId("/repo/a", { homeDir: home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setLastSessionId → getLastSessionId: 저장한 값을 그대로 읽는다", () => {
  const home = tmpHome();
  try {
    setLastSessionId("/repo/a", "sess-1", { homeDir: home });
    assert.equal(getLastSessionId("/repo/a", { homeDir: home }), "sess-1");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setLastSessionId: 같은 repoId 재저장은 값을 덮어쓴다(최신 세션만 유지)", () => {
  const home = tmpHome();
  try {
    setLastSessionId("/repo/a", "sess-1", { homeDir: home });
    setLastSessionId("/repo/a", "sess-2", { homeDir: home });
    assert.equal(getLastSessionId("/repo/a", { homeDir: home }), "sess-2");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setLastSessionId: 다른 repoId는 서로 독립(교차오염 없음)", () => {
  const home = tmpHome();
  try {
    setLastSessionId("/repo/a", "sess-a", { homeDir: home });
    setLastSessionId("/repo/b", "sess-b", { homeDir: home });
    assert.equal(getLastSessionId("/repo/a", { homeDir: home }), "sess-a");
    assert.equal(getLastSessionId("/repo/b", { homeDir: home }), "sess-b");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("clearLastSessionId: 항목 제거 — 이후 getLastSessionId는 null", () => {
  const home = tmpHome();
  try {
    setLastSessionId("/repo/a", "sess-1", { homeDir: home });
    clearLastSessionId("/repo/a", { homeDir: home });
    assert.equal(getLastSessionId("/repo/a", { homeDir: home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("clearLastSessionId: 없는 repoId는 no-op(에러 없이 조용히 무시)", () => {
  const home = tmpHome();
  try {
    assert.doesNotThrow(() => clearLastSessionId("/repo/nonexistent", { homeDir: home }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("getLastSessionId: session-map.json이 배열 등 non-object로 손상돼도 크래시 없이 null(방어, repos.json W4 관례 미러)", () => {
  const home = tmpHome();
  try {
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeFileSync(join(home, ".gbc", "session-map.json"), "[1,2,3]", "utf8");
    assert.equal(getLastSessionId("/repo/a", { homeDir: home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("getLastSessionId: 값이 문자열이 아닌 항목(숫자·객체 등)은 방어 필터로 무시(null)", () => {
  const home = tmpHome();
  try {
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeFileSync(join(home, ".gbc", "session-map.json"), '{"/repo/a": 12345}', "utf8");
    assert.equal(getLastSessionId("/repo/a", { homeDir: home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
