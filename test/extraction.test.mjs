// extraction sink 단정 (0.7.0 A1 ST2). redaction·직렬화 캡·파싱·로테이션·opt-out.
// redaction은 무동작 tautology 위험이 커 RED-first가 load-bearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  redactSecrets,
  serializeRecord,
  parseExtraction,
  appendExtraction,
  extractionPath,
  MAX_LINE,
} from "../dist/extraction.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "gbc-extraction-"));
}

test("redactSecrets: Anthropic 키(sk-ant-…) 마스킹", () => {
  const r = redactSecrets("키는 sk-ant-api03-AbCdEf12345678 입니다");
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /AbCdEf12345678/, "키 본문 제거");
});

test("redactSecrets: Bearer 토큰 마스킹(Bearer 키워드는 보존)", () => {
  const r = redactSecrets("Authorization: Bearer abc123XYZ._-tokenvalue");
  assert.match(r, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(r, /tokenvalue/);
});

test("redactSecrets: KEY/TOKEN/SECRET 대입은 키 이름 보존·값만 마스킹", () => {
  assert.match(redactSecrets("ANTHROPIC_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxx"), /ANTHROPIC_API_KEY=\[REDACTED\]/);
  assert.match(redactSecrets("my_secret: hunter2plaintext"), /my_secret:\s*\[REDACTED\]/i);
  assert.match(redactSecrets('{"token":"deadbeefcafe1234"}'), /token"?\s*[:=]\s*\[REDACTED\]/i);
});

test("redactSecrets: 일반 산문·파일 경로는 훼손 안 함(과다-redaction 금지)", () => {
  const s = "src/hook.ts의 evaluateGate가 pass를 반환했다. README.md 편집.";
  assert.equal(redactSecrets(s), s, "시크릿 패턴 없으면 원문 그대로");
});

test("redactSecrets: AWS 키·GitHub 토큰·Basic·URL 크리덴셜·PEM 마스킹(보안검토 S2 확장)", () => {
  assert.match(redactSecrets("AKIA1234567890ABCDEF 노출"), /\[REDACTED\]/);
  assert.doesNotMatch(redactSecrets("AKIA1234567890ABCDEF"), /ABCDEF$/);
  assert.match(redactSecrets("ghp_0123456789abcdefghijklmnopqrstuvwxyz"), /\[REDACTED\]/);
  assert.match(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA=="), /Basic \[REDACTED\]/);
  const url = redactSecrets("postgres://admin:supersecret@db.host:5432/app");
  assert.match(url, /postgres:\/\/admin:\[REDACTED\]@/, "URL 비밀번호만 마스킹·user·host 보존");
  assert.doesNotMatch(url, /supersecret/);
  const pem = redactSecrets("key=-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY-----");
  assert.doesNotMatch(pem, /MIIabc123/, "PEM 블록 본문 제거");
});

test("serializeRecord: text는 redact 후 직렬화, 한 줄·MAX_LINE 미만", () => {
  const line = serializeRecord({ at: "2026-07-07T00:00:00Z", session: "s1", kind: "gate", decision: "pass", text: "키 sk-ant-api03-SECRETSECRET12 노출" });
  assert.ok(!line.includes("\n"), "한 줄");
  assert.ok(line.length < MAX_LINE);
  assert.match(line, /\[REDACTED\]/, "직렬화 시 redact 적용");
  assert.doesNotMatch(line, /SECRETSECRET12/);
});

test("serializeRecord: 초장문 text는 캡(라인 상한 보장)", () => {
  const line = serializeRecord({ at: "t", session: "s1", kind: "assistant", text: "가".repeat(10000) });
  assert.ok(line.length < MAX_LINE, "라인 상한 미만으로 캡");
});

test("parseExtraction: 유효 jsonl 파싱, 빈 줄·깨진 줄·형상불량 skip", () => {
  const raw = [
    JSON.stringify({ at: "t1", session: "s1", kind: "tool_use", tool: "Edit", file: "a.ts" }),
    "",
    "{깨진 json",
    JSON.stringify({ foo: "bar" }), // session/kind 없음 → skip
    JSON.stringify({ at: "t2", session: "s2", kind: "result" }),
  ].join("\n");
  const recs = parseExtraction(raw);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].session, "s1");
  assert.equal(recs[0].tool, "Edit");
  assert.equal(recs[1].kind, "result");
});

test("appendExtraction: .gbc/extraction.jsonl에 append, 라운드트립 session 보존", () => {
  const cwd = tmp();
  try {
    appendExtraction(cwd, { at: "t1", session: "sess-join-key", kind: "tool_use", tool: "Write", file: "x.ts" });
    appendExtraction(cwd, { at: "t2", session: "sess-join-key", kind: "gate", decision: "block" });
    const recs = parseExtraction(readFileSync(extractionPath(cwd), "utf8"));
    assert.equal(recs.length, 2);
    assert.equal(recs[0].session, "sess-join-key", "session이 유일 조인키로 보존");
    assert.equal(recs[1].decision, "block");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("appendExtraction: 파일이 상한 이상이면 .1로 1세대 로테이션 후 새로 시작", () => {
  const cwd = tmp();
  try {
    const p = extractionPath(cwd);
    const backup = join(cwd, ".gbc", "extraction.1.jsonl");
    // 이미 큰 파일이 있는 상태로 만든 뒤 append → 로테이션 발동
    writeFileSync(p, "x".repeat(500) + "\n");
    appendExtraction(cwd, { at: "t", session: "s1", kind: "result" }, { maxBytes: 100 });
    assert.ok(existsSync(backup), "백업 .1 생성");
    const cur = parseExtraction(readFileSync(p, "utf8"));
    assert.equal(cur.length, 1, "현재 파일은 로테이션 후 새 레코드만");
    assert.equal(cur[0].session, "s1");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("appendExtraction: 상한 미만이면 로테이션 없이 누적", () => {
  const cwd = tmp();
  try {
    appendExtraction(cwd, { at: "t1", session: "s1", kind: "result" }, { maxBytes: 1024 * 1024 });
    appendExtraction(cwd, { at: "t2", session: "s1", kind: "result" }, { maxBytes: 1024 * 1024 });
    const recs = parseExtraction(readFileSync(extractionPath(cwd), "utf8"));
    assert.equal(recs.length, 2, "상한 미만은 append 누적");
    assert.ok(!existsSync(join(cwd, ".gbc", "extraction.1.jsonl")), "로테이션 없음");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("appendExtraction: GBC_NO_EXTRACTION=1이면 무동작(opt-out)", () => {
  const cwd = tmp();
  const prev = process.env.GBC_NO_EXTRACTION;
  process.env.GBC_NO_EXTRACTION = "1";
  try {
    appendExtraction(cwd, { at: "t", session: "s1", kind: "result" });
    assert.ok(!existsSync(extractionPath(cwd)), "opt-out 시 파일 미생성");
  } finally {
    if (prev === undefined) delete process.env.GBC_NO_EXTRACTION;
    else process.env.GBC_NO_EXTRACTION = prev;
    rmSync(cwd, { recursive: true, force: true });
  }
});
