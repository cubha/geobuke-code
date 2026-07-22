// 0.9.2 ST11 — .claude/skills/*/SKILL.md 스캔(skills 패널 데이터 소스, ⌃S).
// 각 SKILL.md는 YAML 유사 frontmatter(---로 감싼 name:/description:)로 시작한다(gbc init이
// 설치하는 gate/gbc-mute/gbc-monitor 스킬 실제 형식). 전체 YAML 파서는 과설계 — 이 두 필드만
// 라인 매칭으로 뽑는다.
import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
}

/** 스킬 출처 — project(cwd/.claude/skills) 또는 global(~/.claude/skills). */
export type SkillOrigin = "project" | "global";

export interface SkillInfoWithOrigin extends SkillInfo {
  origin: SkillOrigin;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/** SKILL.md 본문에서 frontmatter의 name/description을 뽑는다. name 없으면 null(최소 계약 미달).
 * 0.10.3 — 전역 스킬 스캔 확장으로 gbc가 만들지 않은 SKILL.md도 읽게 되면서, YAML 블록 스칼라
 * (`description: >-` 후 들여쓰기 연속행) 형식이 실존함을 실기검증에서 확인 — 그 경우 지시자(">"/
 * ">-" 등)가 아니라 이어지는 들여쓰기 행들을 공백으로 이어 description으로 삼는다(여전히 전체
 * YAML 파서는 과설계 — 이 한 형태만 추가 지원). */
export function parseSkillFrontmatter(content: string): SkillInfo | null {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return null;
  const block = m[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  const descMatch = block.match(/^description:\s*(.+)$/m);
  let description = descMatch ? descMatch[1].trim() : "";
  if (descMatch && /^[>|][+-]?$/.test(description)) {
    const lines = block.split("\n");
    const startIdx = lines.findIndex((l) => /^description:/.test(l));
    const collected: string[] = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s+\S/.test(line)) break; // 들여쓰기 연속행이 끝나면(다음 키 등) 중단
      collected.push(line.trim());
    }
    description = collected.join(" ");
  }
  return { name: nameMatch[1].trim(), description };
}

/**
 * cwd/.claude/skills/<name>/SKILL.md를 전부 읽어 이름순으로 반환한다. 디렉토리 자체가 없으면
 * (gbc init 미실행) 빈 배열 — 에러 아님. 심링크는 거부한다(spec.archive resolveSpecText와
 * 동일 관례 — 프로젝트 밖 임의 파일을 스킬로 노출하는 경로 차단). **엔트리 디렉토리 자체**와
 * SKILL.md 파일 둘 다 lstat 검사한다 — SKILL.md만 검사하면 `.claude/skills/x`가 심링크 디렉토리라도
 * 그 안의 SKILL.md는 일반 파일이라 통과해버리는 우회가 남는다(security-auditor 발견, 2026-07-13).
 */
export function scanSkills(cwd: string): SkillInfo[] {
  return scanSkillsDir(join(cwd, ".claude", "skills"));
}

/** 한 skills 디렉토리를 스캔하는 공통 코어 — scanSkills(프로젝트)와 전역 스캔이 공유한다. */
function scanSkillsDir(dir: string): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(dir)) {
    const entryPath = join(dir, entry);
    const skillFile = join(entryPath, "SKILL.md");
    try {
      if (lstatSync(entryPath).isSymbolicLink()) continue;
      if (!existsSync(skillFile)) continue;
      if (lstatSync(skillFile).isSymbolicLink()) continue;
      const parsed = parseSkillFrontmatter(readFileSync(skillFile, "utf8"));
      if (parsed) out.push(parsed);
    } catch {
      continue; // 개별 스킬 읽기 실패는 그 항목만 건너뜀(패널 전체를 죽이지 않음)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 프로젝트(.claude/skills) + 전역(~/.claude/skills) 스킬을 합쳐 반환한다(0.10.3 — 현장 이슈①:
 * 패널이 프로젝트 스킬만 보여줘 "연동된 AI의 스킬 목록"이 안 보인다는 보고). 연동 엔진(claude)이
 * 실제로 로드하는 두 계층을 그대로 반영하며, 이름 충돌 시 프로젝트가 전역을 가린다(claude 동작과
 * 동일한 우선순위). 플러그인 스킬(~/.claude/plugins 내부)은 이번 스코프 밖 — 마켓플레이스 구조
 * 파싱이 필요해 별도 작업으로 미룬다.
 * globalRoot 인자는 테스트 주입용(기본 homedir).
 */
export function scanSkillsWithOrigin(cwd: string, globalRoot: string = homedir()): SkillInfoWithOrigin[] {
  const project = scanSkillsDir(join(cwd, ".claude", "skills")).map(
    (s): SkillInfoWithOrigin => ({ ...s, origin: "project" }),
  );
  const projectNames = new Set(project.map((s) => s.name));
  const global = scanSkillsDir(join(globalRoot, ".claude", "skills"))
    .filter((s) => !projectNames.has(s.name))
    .map((s): SkillInfoWithOrigin => ({ ...s, origin: "global" }));
  return [...project, ...global].sort((a, b) => a.name.localeCompare(b.name));
}
