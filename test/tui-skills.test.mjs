// 0.9.2 ST11 — .claude/skills/*/SKILL.md 스캔(skills 패널 데이터 소스). YAML 유사 frontmatter의
// name/description만 파싱한다(전체 YAML 파서 도입은 과설계 — 이 프로젝트 SKILL.md는 항상 이 두 필드만 씀).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillFrontmatter, scanSkills, scanSkillsWithOrigin, loadSkillBody } from "../dist/tui/skills.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "gbc-skills-test-"));
}

test("parseSkillFrontmatter: name/description 추출", () => {
  const content = `---
name: gate
description: 게이트 관리 스킬 설명
---

# /gate 본문
`;
  assert.deepEqual(parseSkillFrontmatter(content), { name: "gate", description: "게이트 관리 스킬 설명" });
});

test("parseSkillFrontmatter: description 없으면 빈 문자열", () => {
  const content = `---
name: solo
---
본문
`;
  assert.deepEqual(parseSkillFrontmatter(content), { name: "solo", description: "" });
});

test("parseSkillFrontmatter: frontmatter 없으면 null", () => {
  assert.equal(parseSkillFrontmatter("# 그냥 마크다운\n본문"), null);
});

test("parseSkillFrontmatter: name 없으면 null(최소 계약)", () => {
  const content = `---
description: name 없는 케이스
---
`;
  assert.equal(parseSkillFrontmatter(content), null);
});

test("scanSkills: .claude/skills/*/SKILL.md 전부 읽어 이름순 정렬", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, ".claude", "skills", "zeta"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "zeta", "SKILL.md"), "---\nname: zeta\ndescription: Z\n---\n");
    mkdirSync(join(dir, ".claude", "skills", "alpha"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\n");
    const out = scanSkills(dir);
    assert.deepEqual(out.map((s) => s.name), ["alpha", "zeta"]);
    assert.equal(out[0].description, "A");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanSkills: .claude/skills 디렉토리 자체가 없으면 빈 배열(gbc init 안 한 프로젝트)", () => {
  const dir = tmp();
  try {
    assert.deepEqual(scanSkills(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanSkills: SKILL.md 없는 폴더·frontmatter 없는 SKILL.md는 건너뜀(폴백으로 죽은 항목 안 만듦)", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, ".claude", "skills", "empty-folder"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "no-frontmatter"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "no-frontmatter", "SKILL.md"), "# 그냥 마크다운\n");
    mkdirSync(join(dir, ".claude", "skills", "ok"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "ok", "SKILL.md"), "---\nname: ok\ndescription: 정상\n---\n");
    const out = scanSkills(dir);
    assert.deepEqual(out.map((s) => s.name), ["ok"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanSkills: 심링크 SKILL.md는 거부(cross-repo 집계·spec.archive와 동일 관례)", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    writeFileSync(join(outside, "SKILL.md"), "---\nname: outside\ndescription: 외부\n---\n");
    mkdirSync(join(dir, ".claude", "skills", "linked"), { recursive: true });
    symlinkSync(join(outside, "SKILL.md"), join(dir, ".claude", "skills", "linked", "SKILL.md"));
    assert.deepEqual(scanSkills(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("scanSkills: 심링크 '디렉토리'(SKILL.md 자체는 일반 파일)도 거부(security-auditor 발견 — 최종 파일만 lstat하면 우회됨)", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "---\nname: outside\ndescription: 외부\n---\n");
    mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
    symlinkSync(outside, join(dir, ".claude", "skills", "linked-dir"));
    assert.deepEqual(scanSkills(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── scanSkillsWithOrigin (0.10.3 — 현장 이슈①: 전역 스킬 미표시) ──

test("scanSkillsWithOrigin: 프로젝트+전역 합산, origin 태깅, 이름순 정렬", () => {
  const proj = tmp();
  const home = tmp();
  try {
    mkdirSync(join(proj, ".claude", "skills", "gate"), { recursive: true });
    writeFileSync(join(proj, ".claude", "skills", "gate", "SKILL.md"), "---\nname: gate\ndescription: P\n---\n");
    mkdirSync(join(home, ".claude", "skills", "analyze"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "analyze", "SKILL.md"), "---\nname: analyze\ndescription: G\n---\n");
    const out = scanSkillsWithOrigin(proj, home);
    assert.deepEqual(
      out.map((s) => [s.name, s.origin]),
      [["analyze", "global"], ["gate", "project"]],
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanSkillsWithOrigin: 이름 충돌 시 프로젝트가 전역을 가린다(claude 로드 우선순위와 동일)", () => {
  const proj = tmp();
  const home = tmp();
  try {
    mkdirSync(join(proj, ".claude", "skills", "gate"), { recursive: true });
    writeFileSync(join(proj, ".claude", "skills", "gate", "SKILL.md"), "---\nname: gate\ndescription: 프로젝트판\n---\n");
    mkdirSync(join(home, ".claude", "skills", "gate"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "gate", "SKILL.md"), "---\nname: gate\ndescription: 전역판\n---\n");
    const out = scanSkillsWithOrigin(proj, home);
    assert.equal(out.length, 1);
    assert.equal(out[0].origin, "project");
    assert.equal(out[0].description, "프로젝트판");
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanSkillsWithOrigin: 전역 디렉토리 없음 → 프로젝트만(에러 아님)", () => {
  const proj = tmp();
  try {
    mkdirSync(join(proj, ".claude", "skills", "gate"), { recursive: true });
    writeFileSync(join(proj, ".claude", "skills", "gate", "SKILL.md"), "---\nname: gate\ndescription: P\n---\n");
    const out = scanSkillsWithOrigin(proj, join(proj, "no-such-home"));
    assert.deepEqual(out.map((s) => [s.name, s.origin]), [["gate", "project"]]);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

// ── path 필드 + loadSkillBody (0.10.4 ST4 — 개선1: 슬래시 드롭다운이 선택된 스킬 본문을 프롬프트에
// 주입하려면 SKILL.md 절대경로가 필요하다) ──

test("scanSkillsWithOrigin: 각 항목에 SKILL.md 절대경로(path) 포함", () => {
  const proj = tmp();
  try {
    mkdirSync(join(proj, ".claude", "skills", "gate"), { recursive: true });
    writeFileSync(join(proj, ".claude", "skills", "gate", "SKILL.md"), "---\nname: gate\ndescription: P\n---\n");
    const out = scanSkillsWithOrigin(proj, join(proj, "no-such-home"));
    assert.equal(out[0].path, join(proj, ".claude", "skills", "gate", "SKILL.md"));
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("loadSkillBody: 정상 경로는 SKILL.md 전문을 그대로 반환", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, ".claude", "skills", "gate"), { recursive: true });
    const p = join(dir, ".claude", "skills", "gate", "SKILL.md");
    writeFileSync(p, "---\nname: gate\ndescription: P\n---\n본문 내용\n");
    assert.match(loadSkillBody(p), /본문 내용/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSkillBody: 존재하지 않는 경로는 null(크래시 없음)", () => {
  assert.equal(loadSkillBody("/no/such/path/SKILL.md"), null);
});

test("loadSkillBody: SKILL.md 심링크는 거부(null) — 제출 시점 재검사", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    writeFileSync(join(outside, "SKILL.md"), "---\nname: outside\ndescription: 외부\n---\n악성 본문\n");
    mkdirSync(join(dir, ".claude", "skills", "linked"), { recursive: true });
    const p = join(dir, ".claude", "skills", "linked", "SKILL.md");
    symlinkSync(join(outside, "SKILL.md"), p);
    assert.equal(loadSkillBody(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("loadSkillBody: 엔트리 디렉토리 자체가 심링크면 거부(null)", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    mkdirSync(outside, { recursive: true });
    const outsideSkill = join(outside, "SKILL.md");
    writeFileSync(outsideSkill, "---\nname: outside\ndescription: 외부\n---\n악성 본문\n");
    mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
    symlinkSync(outside, join(dir, ".claude", "skills", "linked-dir"));
    const p = join(dir, ".claude", "skills", "linked-dir", "SKILL.md");
    assert.equal(loadSkillBody(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("parseSkillFrontmatter: YAML 블록 스칼라(>-) description — 지시자가 아니라 연속행 텍스트를 취한다", () => {
  const content = `---
name: braintrust
description: >-
  적대검토 인-세션 패널.
  중대한 결정 전 교차검증.
allowed-tools: all
---
본문
`;
  const out = parseSkillFrontmatter(content);
  assert.equal(out.name, "braintrust");
  assert.equal(out.description, "적대검토 인-세션 패널. 중대한 결정 전 교차검증.");
});
