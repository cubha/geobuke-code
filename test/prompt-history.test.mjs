// ST3-2(0.11.0) — repoId→프롬프트 히스토리 세션간 영속(src/prompt-history.ts).
// session-map.ts(repoId→sessionId 영속)와 동일 관례: ~/.gbc/prompt-history.json, homeDir 주입으로
// 실제 홈을 건드리지 않고 테스트한다. 프롬프트 원문을 디스크에 남기는 시크릿 유입 표면이라
// extraction.ts redactSecrets를 재사용하고, GBC_NO_PROMPT_HISTORY로 전체를 끌 수 있다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptHistory, appendPromptHistory } from "../dist/prompt-history.js";

function tmpHome() {
  return mkdtempSync(join(tmpdir(), "gbc-prompt-history-test-"));
}

test("loadPromptHistory: 저장된 적 없는 repoId는 빈 배열", () => {
  const home = tmpHome();
  try {
    assert.deepEqual(loadPromptHistory("/repo/a", { homeDir: home }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("appendPromptHistory → loadPromptHistory: 저장한 순서 그대로(FIFO append)", () => {
  const home = tmpHome();
  try {
    appendPromptHistory("/repo/a", "첫번째", { homeDir: home });
    appendPromptHistory("/repo/a", "두번째", { homeDir: home });
    assert.deepEqual(loadPromptHistory("/repo/a", { homeDir: home }), ["첫번째", "두번째"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("appendPromptHistory: 다른 repoId는 서로 독립(교차오염 없음)", () => {
  const home = tmpHome();
  try {
    appendPromptHistory("/repo/a", "a용", { homeDir: home });
    appendPromptHistory("/repo/b", "b용", { homeDir: home });
    assert.deepEqual(loadPromptHistory("/repo/a", { homeDir: home }), ["a용"]);
    assert.deepEqual(loadPromptHistory("/repo/b", { homeDir: home }), ["b용"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("appendPromptHistory: 연속 중복은 추가하지 않는다(editor.ts commitSubmit과 동일 규약)", () => {
  const home = tmpHome();
  try {
    appendPromptHistory("/repo/a", "same", { homeDir: home });
    appendPromptHistory("/repo/a", "same", { homeDir: home });
    assert.deepEqual(loadPromptHistory("/repo/a", { homeDir: home }), ["same"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("appendPromptHistory: 시크릿 패턴은 저장 전 redact된다(extraction.ts redactSecrets 재사용)", () => {
  const home = tmpHome();
  try {
    appendPromptHistory("/repo/a", "내 키는 sk-ant-abcdefgh12345678 이야", { homeDir: home });
    const [saved] = loadPromptHistory("/repo/a", { homeDir: home });
    assert.doesNotMatch(saved, /sk-ant-abcdefgh12345678/);
    assert.match(saved, /\[REDACTED\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("appendPromptHistory: repo당 최근 100건만 유지(상한 초과 시 오래된 것부터 제거)", () => {
  const home = tmpHome();
  try {
    for (let i = 0; i < 105; i++) appendPromptHistory("/repo/a", `p${i}`, { homeDir: home });
    const saved = loadPromptHistory("/repo/a", { homeDir: home });
    assert.equal(saved.length, 100);
    assert.equal(saved[0], "p5", "가장 오래된 5건이 밀려나야 함");
    assert.equal(saved[99], "p104");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GBC_NO_PROMPT_HISTORY=1 — append도 load도 완전히 no-op", () => {
  const home = tmpHome();
  const prev = process.env.GBC_NO_PROMPT_HISTORY;
  process.env.GBC_NO_PROMPT_HISTORY = "1";
  try {
    appendPromptHistory("/repo/a", "안 남아야 함", { homeDir: home });
    assert.deepEqual(loadPromptHistory("/repo/a", { homeDir: home }), []);
  } finally {
    if (prev === undefined) delete process.env.GBC_NO_PROMPT_HISTORY;
    else process.env.GBC_NO_PROMPT_HISTORY = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadPromptHistory: prompt-history.json이 배열 등 non-object로 손상돼도 크래시 없이 빈 배열(session-map.ts W4 관례 미러)", () => {
  const home = tmpHome();
  try {
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeFileSync(join(home, ".gbc", "prompt-history.json"), "[1,2,3]", "utf8");
    assert.deepEqual(loadPromptHistory("/repo/a", { homeDir: home }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadPromptHistory: 값이 배열이 아니거나 배열 원소가 문자열이 아니면 방어 필터로 제외", () => {
  const home = tmpHome();
  try {
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeFileSync(join(home, ".gbc", "prompt-history.json"), '{"/repo/a": "not-array", "/repo/b": ["ok", 123, "ok2"]}', "utf8");
    assert.deepEqual(loadPromptHistory("/repo/a", { homeDir: home }), []);
    assert.deepEqual(loadPromptHistory("/repo/b", { homeDir: home }), ["ok", "ok2"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
