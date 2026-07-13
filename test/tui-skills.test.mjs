// 0.9.2 ST11 — .claude/skills/*/SKILL.md 스캔(skills 패널 데이터 소스). YAML 유사 frontmatter의
// name/description만 파싱한다(전체 YAML 파서 도입은 과설계 — 이 프로젝트 SKILL.md는 항상 이 두 필드만 씀).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillFrontmatter, scanSkills } from "../dist/tui/skills.js";

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
