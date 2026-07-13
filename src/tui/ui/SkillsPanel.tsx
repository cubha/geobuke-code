// 0.9.2 ST12 — A-⑤ skills 패널(⌃S). ReposPanel과 동일하게 읽기전용 1회 로드(SKILL.md는 세션
// 도중 바뀌지 않는 정적 설치물이라 MetricsPanel의 fs.watch 갱신은 불필요 — 재오픈 시 다시 스캔).
import React from "react";
import { Box, Text } from "ink";
import { scanSkills } from "../skills.js";

export function SkillsPanel({ cwd }: { cwd: string }) {
  const skills = scanSkills(cwd);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" bold>
        🧩 skills <Text color="gray">— .claude/skills · 읽기전용</Text>
      </Text>
      {skills.length === 0 ? (
        <Text color="gray">설치된 skill 없음 — 'gbc init'으로 설치</Text>
      ) : (
        skills.map((s) => (
          <Text key={s.name}>
            <Text color="green">/{s.name}</Text>
            {s.description ? <Text color="gray"> — {s.description.slice(0, 80)}</Text> : null}
          </Text>
        ))
      )}
    </Box>
  );
}
