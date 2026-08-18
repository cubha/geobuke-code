// applied ledger — 작업단위 구현이력 부재 근본수정(0.12.3 P2a, SubTask1). 게이트가 매 편집을
// 백지 재평가하던 근본원인은 gbc엔 PostToolUse가 없어 "방금 그 편집이 실제 적용됐다"는 사실 자체를
// 알 방법이 없었던 것(0.12.0 RCA: 03:02→03:17→03:17→03:23 4회 재차단, 그 사이 모델은 순차 구현
// 중이었다). 이 파일은 순수 부품 + 파일 I/O 원장만 담는다(judge 프롬프트 배선은 SubTask2, gate-core
// 배선은 SubTask3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  summarizeAppliedEdit,
  buildAppliedEntry,
  loadApplied,
  recordApplied,
  clearApplied,
  selectAppliedForJudge,
  formatAppliedContext,
  isAppliedFailure,
  normalizeAppliedFile,
  extractAppliedAnchors,
  verifyAppliedEntry,
  MAX_APPLIED_ENTRIES,
  MAX_APPLIED_DIGEST,
  MAX_APPLIED_CONTEXT_CHARS,
} from "../dist/applied.js";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "gbc-applied-test-"));
}

// ===== summarizeAppliedEdit — 새 내용만(old_string 제외), redact+캡 =====

test("summarizeAppliedEdit: Edit는 new_string만 담는다(old_string 제외)", () => {
  const out = summarizeAppliedEdit("Edit", { file_path: "/p/a.ts", old_string: "foo()", new_string: "bar()" });
  assert.equal(out, "bar()");
  assert.ok(!out.includes("foo()"));
});

test("summarizeAppliedEdit: MultiEdit는 edits[].new_string을 결합한다", () => {
  const out = summarizeAppliedEdit("MultiEdit", {
    file_path: "/p/a.ts",
    edits: [
      { old_string: "a", new_string: "A" },
      { old_string: "b", new_string: "B" },
    ],
  });
  assert.ok(out.includes("A"));
  assert.ok(out.includes("B"));
});

test("summarizeAppliedEdit: Write는 content 전체를 담는다", () => {
  const out = summarizeAppliedEdit("Write", { file_path: "/p/a.ts", content: "export const x = 1;" });
  assert.equal(out, "export const x = 1;");
});

test("summarizeAppliedEdit: 시크릿을 마스킹한다(redactSecrets 재사용)", () => {
  const out = summarizeAppliedEdit("Edit", {
    file_path: "/p/a.ts",
    old_string: "x",
    new_string: 'const key = "sk-ant-abcdefgh12345678";',
  });
  assert.ok(!out.includes("sk-ant-abcdefgh12345678"));
});

test("summarizeAppliedEdit: MAX_APPLIED_DIGEST 초과분은 절단한다", () => {
  const long = "x".repeat(MAX_APPLIED_DIGEST + 500);
  const out = summarizeAppliedEdit("Write", { file_path: "/p/a.ts", content: long });
  assert.ok(out.length < long.length);
  assert.ok(out.includes("절단"));
});

test("summarizeAppliedEdit: 새 내용이 없으면 빈 문자열", () => {
  assert.equal(summarizeAppliedEdit("Edit", { file_path: "/p/a.ts", old_string: "x", new_string: "" }), "");
});

// ===== buildAppliedEntry — 기록 대상 판별(순수) =====

test("buildAppliedEntry: 게이트 대상 도구(Edit/Write/MultiEdit)만 엔트리를 만든다", () => {
  const entry = buildAppliedEntry("Edit", { file_path: "/root/a.ts", old_string: "x", new_string: "y" }, "/root", "2026-08-13T00:00:00Z");
  assert.ok(entry);
  assert.equal(entry.tool, "Edit");
  assert.equal(entry.file, "a.ts");
  assert.equal(entry.digest, "y");
  assert.equal(entry.at, "2026-08-13T00:00:00Z");
});

test("buildAppliedEntry: 게이트 대상 아닌 도구(Bash 등)는 null", () => {
  assert.equal(buildAppliedEntry("Bash", { file_path: "/root/a.ts" }, "/root", "2026-08-13T00:00:00Z"), null);
});

test("buildAppliedEntry: file_path 없으면 null", () => {
  assert.equal(buildAppliedEntry("Edit", { old_string: "x", new_string: "y" }, "/root", "2026-08-13T00:00:00Z"), null);
});

test("buildAppliedEntry: 새 내용이 빈 편집(순수 삭제)은 null — 기록할 '구현'이 없다", () => {
  assert.equal(buildAppliedEntry("Edit", { file_path: "/root/a.ts", old_string: "x", new_string: "" }, "/root", "2026-08-13T00:00:00Z"), null);
});

test("buildAppliedEntry: cwd 밖 파일은 basename만 담는다", () => {
  const entry = buildAppliedEntry("Write", { file_path: "/other/deep/b.ts", content: "z" }, "/root", "2026-08-13T00:00:00Z");
  assert.equal(entry.file, "b.ts");
});

// ===== outside 마커 + session 라이더(0.12.4 ST2) =====

test("buildAppliedEntry: cwd 밖 파일은 outside:true 마커를 단다(basename만 담겨 매칭키로 못 쓴다는 표시)", () => {
  const entry = buildAppliedEntry("Write", { file_path: "/other/deep/b.ts", content: "z" }, "/root", "2026-08-13T00:00:00Z");
  assert.equal(entry.outside, true);
});

test("buildAppliedEntry: cwd 안 파일은 outside 마커가 없다(undefined로 채우지 않는 기존 관례)", () => {
  const entry = buildAppliedEntry("Edit", { file_path: "/root/a.ts", old_string: "x", new_string: "y" }, "/root", "2026-08-13T00:00:00Z");
  assert.equal(entry.outside, undefined);
});

test("buildAppliedEntry: session을 넘기면 엔트리에 기록된다(판정 미사용 — 라이더)", () => {
  const entry = buildAppliedEntry("Edit", { file_path: "/root/a.ts", old_string: "x", new_string: "y" }, "/root", "2026-08-13T00:00:00Z", "sess-123");
  assert.equal(entry.session, "sess-123");
});

test("buildAppliedEntry: session을 안 넘기면 필드 자체가 없다", () => {
  const entry = buildAppliedEntry("Edit", { file_path: "/root/a.ts", old_string: "x", new_string: "y" }, "/root", "2026-08-13T00:00:00Z");
  assert.equal("session" in entry, false);
});

// ===== normalizeAppliedFile — buildAppliedEntry·selectAppliedForJudge 공유 정규화 =====

test("normalizeAppliedFile: cwd 하위는 상대경로", () => {
  assert.equal(normalizeAppliedFile("/root", "/root/src/a.ts"), "src/a.ts");
});

test("normalizeAppliedFile: cwd 밖은 basename", () => {
  assert.equal(normalizeAppliedFile("/root", "/etc/passwd"), "passwd");
});

// ===== loadApplied / recordApplied / clearApplied — .gbc/applied.json I/O =====

test("loadApplied: 파일 없으면 빈 배열", () => {
  const root = tmpRoot();
  try {
    assert.deepEqual(loadApplied(root, "hash1"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordApplied → loadApplied: 같은 specHash면 누적된다", () => {
  const root = tmpRoot();
  try {
    recordApplied(root, "hash1", { at: "t1", tool: "Edit", file: "a.ts", digest: "A" });
    recordApplied(root, "hash1", { at: "t2", tool: "Edit", file: "b.ts", digest: "B" });
    const entries = loadApplied(root, "hash1");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].file, "a.ts");
    assert.equal(entries[1].file, "b.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadApplied: specHash가 다르면(작업단위 전환) 빈 배열 — 원장 자동 무효화", () => {
  const root = tmpRoot();
  try {
    recordApplied(root, "hash1", { at: "t1", tool: "Edit", file: "a.ts", digest: "A" });
    assert.deepEqual(loadApplied(root, "hash2"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordApplied: specHash가 바뀌면 원장을 새로 시작한다(이전 엔트리 폐기)", () => {
  const root = tmpRoot();
  try {
    recordApplied(root, "hash1", { at: "t1", tool: "Edit", file: "a.ts", digest: "A" });
    recordApplied(root, "hash2", { at: "t2", tool: "Edit", file: "b.ts", digest: "B" });
    const entries = loadApplied(root, "hash2");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].file, "b.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordApplied: 빈 명세(specHash='')는 절대 기록하지 않는다", () => {
  const root = tmpRoot();
  try {
    recordApplied(root, "", { at: "t1", tool: "Edit", file: "a.ts", digest: "A" });
    assert.equal(existsSync(join(root, ".gbc", "applied.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadApplied: specHash=''는 절대 조회하지 않는다(설령 저장돼 있어도)", () => {
  const root = tmpRoot();
  try {
    recordApplied(root, "hash1", { at: "t1", tool: "Edit", file: "a.ts", digest: "A" });
    assert.deepEqual(loadApplied(root, ""), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordApplied: MAX_APPLIED_ENTRIES 초과 시 FIFO로 오래된 것부터 버린다", () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < MAX_APPLIED_ENTRIES + 5; i++) {
      recordApplied(root, "hash1", { at: `t${i}`, tool: "Edit", file: `f${i}.ts`, digest: `D${i}` });
    }
    const entries = loadApplied(root, "hash1");
    assert.equal(entries.length, MAX_APPLIED_ENTRIES);
    assert.equal(entries[0].file, "f5.ts"); // 0~4는 버려짐
    assert.equal(entries[entries.length - 1].file, `f${MAX_APPLIED_ENTRIES + 4}.ts`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearApplied: 파일을 지운다", () => {
  const root = tmpRoot();
  try {
    recordApplied(root, "hash1", { at: "t1", tool: "Edit", file: "a.ts", digest: "A" });
    clearApplied(root);
    assert.equal(existsSync(join(root, ".gbc", "applied.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearApplied: 파일이 없어도 멱등(에러 없음)", () => {
  const root = tmpRoot();
  try {
    assert.doesNotThrow(() => clearApplied(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordApplied: at-rest 값은 이미 마스킹·캡된 digest 그대로 저장된다(기록 시점 1곳 마스킹)", () => {
  const root = tmpRoot();
  try {
    recordApplied(root, "hash1", { at: "t1", tool: "Edit", file: "a.ts", digest: "plain-digest" });
    const raw = JSON.parse(readFileSync(join(root, ".gbc", "applied.json"), "utf8"));
    assert.equal(raw.entries[0].digest, "plain-digest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===== selectAppliedForJudge — Write self-file 필터(GATE_SYSTEM ★★ 대칭) =====

test("selectAppliedForJudge: overwriteFile과 같은 파일의 과거 엔트리를 뺀다", () => {
  const entries = [
    { at: "t1", tool: "Edit", file: "a.ts", digest: "A" },
    { at: "t2", tool: "Edit", file: "b.ts", digest: "B" },
  ];
  const out = selectAppliedForJudge(entries, { overwriteFile: "a.ts" });
  assert.deepEqual(out.map((e) => e.file), ["b.ts"]);
});

test("selectAppliedForJudge: overwriteFile 없으면 전부 유지(Edit/MultiEdit 경로)", () => {
  const entries = [
    { at: "t1", tool: "Edit", file: "a.ts", digest: "A" },
    { at: "t2", tool: "Edit", file: "b.ts", digest: "B" },
  ];
  const out = selectAppliedForJudge(entries, {});
  assert.equal(out.length, 2);
});

// ===== selectAppliedForJudge — 원장 생존 재검증 필터(0.12.4 ST2, security-auditor Critical) =====

test("selectAppliedForJudge: verify가 stale로 답한 엔트리는 뺀다", () => {
  const entries = [
    { at: "t1", tool: "Edit", file: "a.ts", digest: "A" },
    { at: "t2", tool: "Edit", file: "b.ts", digest: "B" },
  ];
  const out = selectAppliedForJudge(entries, { verify: (e) => (e.file === "a.ts" ? "stale" : "alive") });
  assert.deepEqual(out.map((e) => e.file), ["b.ts"]);
});

test("selectAppliedForJudge: alive·unverifiable은 유지한다(불확정을 버리지 않는다)", () => {
  const entries = [
    { at: "t1", tool: "Edit", file: "a.ts", digest: "A" },
    { at: "t2", tool: "Edit", file: "b.ts", digest: "B" },
  ];
  const out = selectAppliedForJudge(entries, { verify: (e) => (e.file === "a.ts" ? "alive" : "unverifiable") });
  assert.equal(out.length, 2);
});

test("selectAppliedForJudge: overwriteFile과 verify를 함께 적용한다(직교 필터)", () => {
  const entries = [
    { at: "t1", tool: "Edit", file: "a.ts", digest: "A" },
    { at: "t2", tool: "Edit", file: "b.ts", digest: "B" },
    { at: "t3", tool: "Edit", file: "c.ts", digest: "C" },
  ];
  const out = selectAppliedForJudge(entries, { overwriteFile: "a.ts", verify: (e) => (e.file === "b.ts" ? "stale" : "alive") });
  assert.deepEqual(out.map((e) => e.file), ["c.ts"]);
});

// ===== formatAppliedContext — 프롬프트 조립(순수, 예산 캡) =====

test("formatAppliedContext: 빈 배열은 빈 텍스트", () => {
  assert.deepEqual(formatAppliedContext([]), { text: "", dropped: 0 });
});

test("formatAppliedContext: 오래된→최신 순 번호, 최신 항목 마킹", () => {
  const entries = [
    { at: "t1", tool: "Edit", file: "a.ts", digest: "A" },
    { at: "t2", tool: "Edit", file: "b.ts", digest: "B" },
  ];
  const { text, dropped } = formatAppliedContext(entries);
  assert.equal(dropped, 0);
  const lines = text.split("\n").filter((l) => /^\d+\./.test(l));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("1."));
  assert.ok(lines[0].includes("a.ts"));
  assert.ok(lines[1].startsWith("2."));
  assert.ok(lines[1].includes("b.ts"));
  assert.ok(lines[1].includes("최신")); // 마지막(최신) 엔트리만 마킹
  assert.ok(!lines[0].includes("최신"));
});

test("formatAppliedContext: 총량 상한 초과 시 최신순으로 배정하고 오래된 것부터 생략한다", () => {
  const big = "x".repeat(MAX_APPLIED_CONTEXT_CHARS - 50);
  const entries = [
    { at: "t1", tool: "Edit", file: "old.ts", digest: big },
    { at: "t2", tool: "Edit", file: "new.ts", digest: big },
  ];
  const { text, dropped } = formatAppliedContext(entries);
  assert.equal(dropped, 1);
  assert.ok(text.includes("new.ts")); // 최신은 반드시 포함
  assert.ok(!text.includes("old.ts")); // 오래된 쪽이 생략
  assert.ok(text.includes("생략"));
});

test("formatAppliedContext: 첫(가장 최신) 엔트리 하나가 상한을 넘어도 통째로 담는다", () => {
  const huge = "x".repeat(MAX_APPLIED_CONTEXT_CHARS + 1000);
  const entries = [{ at: "t1", tool: "Edit", file: "a.ts", digest: huge }];
  const { text, dropped } = formatAppliedContext(entries);
  assert.equal(dropped, 0);
  assert.ok(text.includes(huge));
});

// ── 0.12.3 ship 보안검토 후속(S6) ─────────────────────────────────────────────
// PostToolUse는 도구 실행 **후** 발화하지만 성공만 골라 발화한다는 보장은 hook 계약에
// 대한 가정일 뿐 코드가 검증하는 바가 아니었다. Edit의 old_string 매칭 실패로 도구가
// 에러를 반환해도 우리는 tool_input의 new_string만 보고 "적용됨"으로 기록했다 —
// 디스크에 없는 코드가 "완료된 사실"로 judge에 제출되면 실제 누락이 통과한다(미탐).
//
// 방향 선택: **실패 신호가 있을 때만 버린다.** 반대로 "성공 신호가 있을 때만 기록"하면
// tool_response 형상이 조금만 달라져도 P2a가 통째로 무동작이 되어 RCA 결함으로 되돌아간다
// (fail-open 관례와 동일 — 새 가드의 오작동이 기존 기능을 죽이면 안 된다).
test("isAppliedFailure: 실패 신호가 있는 tool_response는 기록 대상이 아니다", () => {
  assert.equal(isAppliedFailure({ success: false }), true);
  assert.equal(isAppliedFailure({ error: "String to replace not found in file." }), true);
  assert.equal(isAppliedFailure({ is_error: true }), true);
});

test("isAppliedFailure: 성공·미상은 기록한다(형상 변화가 P2a를 통째로 죽이지 않게)", () => {
  assert.equal(isAppliedFailure(undefined), false, "tool_response 자체가 없으면 기존 동작 보존");
  assert.equal(isAppliedFailure({}), false);
  assert.equal(isAppliedFailure({ filePath: "/a/b.ts", success: true }), false);
  assert.equal(isAppliedFailure("Edit 적용 완료"), false, "문자열 응답은 실패 단정 불가 — 기록");
  assert.equal(isAppliedFailure({ error: "" }), false, "빈 error는 실패 신호가 아니다");
});

// ── extractAppliedAnchors — 원장 생존 재검증(0.12.4 ST2)의 입력 정제 ────────────────────────
// digest에서 "파일과 바이트 비교해 의미 있는" 줄만 남긴다. 절단·마스킹·공백 줄은 항상 불일치로
// 나와 거짓 stale을 만들므로 앵커에서 뺀다.

test("extractAppliedAnchors: 절단되지 않은 digest는 전체 줄을 앵커로 쓴다(빈 줄 제외)", () => {
  const digest = summarizeAppliedEdit("Write", { file_path: "/p/a.ts", content: "line1\n\nline2" });
  assert.deepEqual(extractAppliedAnchors(digest), ["line1", "line2"]);
});

test("extractAppliedAnchors: 절단된 digest는 마커 줄과 그 직전(중간절단) 줄을 뺀다", () => {
  // 실제 절단 경로(summarizeAppliedEdit)로 만든다 — 손으로 마커 문자열을 흉내내지 않는다(F-1 교훈).
  const longLine = "x".repeat(MAX_APPLIED_DIGEST + 200);
  const digest = summarizeAppliedEdit("Write", { file_path: "/p/a.ts", content: `keep-me\n${longLine}` });
  assert.ok(digest.endsWith("\n…(절단됨)"), "전제: 실제로 절단됐다");
  const anchors = extractAppliedAnchors(digest);
  assert.deepEqual(anchors, ["keep-me"]);
});

test("extractAppliedAnchors: redactSecrets 마스킹 줄은 뺀다(원본과 바이트가 달라 항상 불일치)", () => {
  const digest = summarizeAppliedEdit("Edit", {
    file_path: "/p/a.ts",
    old_string: "x",
    new_string: 'keep-me\nconst key = "sk-ant-abcdefgh12345678";',
  });
  assert.ok(digest.includes("[REDACTED]"), "전제: 실제로 마스킹됐다");
  assert.deepEqual(extractAppliedAnchors(digest), ["keep-me"]);
});

test("extractAppliedAnchors: 앵커가 하나도 안 남으면 빈 배열", () => {
  assert.deepEqual(extractAppliedAnchors("   \n  \n"), []);
});

// ── verifyAppliedEntry — 3-상태 생존 재검증(순수, security-auditor Critical 본체) ──────────────

test("verifyAppliedEntry: 앵커가 파일에 남아있으면 alive", () => {
  const entry = { at: "t", tool: "Edit", file: "a.ts", digest: "function impl() {}" };
  assert.equal(verifyAppliedEntry(entry, "// 위\nfunction impl() {}\n// 아래"), "alive");
});

test("verifyAppliedEntry: 앵커가 전부 없으면 stale(적극적 반증)", () => {
  const entry = { at: "t", tool: "Edit", file: "a.ts", digest: "function impl() {}" };
  assert.equal(verifyAppliedEntry(entry, "// impl은 삭제됨\nfunction other() {}"), "stale");
});

test("verifyAppliedEntry: 앵커 일부만 남아도 alive(부분 일치는 리팩토링일 수 있다 — 전부 없어야 stale)", () => {
  const entry = { at: "t", tool: "MultiEdit", file: "a.ts", digest: "line-A\nline-B" };
  assert.equal(verifyAppliedEntry(entry, "line-A만 남음"), "alive");
});

test("verifyAppliedEntry: fileText가 null이면 unverifiable(읽기 실패·미판별을 stale로 단정하지 않는다)", () => {
  const entry = { at: "t", tool: "Edit", file: "a.ts", digest: "function impl() {}" };
  assert.equal(verifyAppliedEntry(entry, null), "unverifiable");
});

test("verifyAppliedEntry: outside 마커가 있으면 fileText를 안 보고 항상 unverifiable(동명이인 오판 방지)", () => {
  const entry = { at: "t", tool: "Edit", file: "a.ts", digest: "function impl() {}", outside: true };
  assert.equal(verifyAppliedEntry(entry, "function impl() {}"), "unverifiable");
});

test("verifyAppliedEntry: 앵커가 0개면(전부 절단·마스킹·공백) unverifiable — 비교할 게 없다", () => {
  const entry = { at: "t", tool: "Edit", file: "a.ts", digest: "   " };
  assert.equal(verifyAppliedEntry(entry, "아무 내용"), "unverifiable");
});
