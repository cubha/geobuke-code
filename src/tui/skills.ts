// 0.9.2 ST11 — .claude/skills/*/SKILL.md 스캔(skills 패널 데이터 소스, ⌃S).
// 각 SKILL.md는 YAML 유사 frontmatter(---로 감싼 name:/description:)로 시작한다(gbc init이
// 설치하는 gate/gbc-mute/gbc-monitor 스킬 실제 형식). 전체 YAML 파서는 과설계 — 이 두 필드만
// 라인 매칭으로 뽑는다.
import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/** SKILL.md 본문에서 frontmatter의 name/description을 뽑는다. name 없으면 null(최소 계약 미달). */
export function parseSkillFrontmatter(content: string): SkillInfo | null {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return null;
  const block = m[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  const descMatch = block.match(/^description:\s*(.+)$/m);
  return { name: nameMatch[1].trim(), description: descMatch ? descMatch[1].trim() : "" };
}

/**
 * cwd/.claude/skills/<name>/SKILL.md를 전부 읽어 이름순으로 반환한다. 디렉토리 자체가 없으면
 * (gbc init 미실행) 빈 배열 — 에러 아님. 심링크는 거부한다(spec.archive resolveSpecText와
 * 동일 관례 — 프로젝트 밖 임의 파일을 스킬로 노출하는 경로 차단). **엔트리 디렉토리 자체**와
 * SKILL.md 파일 둘 다 lstat 검사한다 — SKILL.md만 검사하면 `.claude/skills/x`가 심링크 디렉토리라도
 * 그 안의 SKILL.md는 일반 파일이라 통과해버리는 우회가 남는다(security-auditor 발견, 2026-07-13).
 */
export function scanSkills(cwd: string): SkillInfo[] {
  const dir = join(cwd, ".claude", "skills");
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
