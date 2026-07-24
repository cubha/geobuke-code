// 0.9.2 ST12 — A-⑤ skills 패널(⌃S/Alt+S). ReposPanel과 동일하게 읽기전용 로드(SKILL.md는 세션
// 도중 바뀌지 않는 정적 설치물이라 MetricsPanel의 fs.watch 갱신은 불필요 — 재오픈 시 다시 스캔).
// 0.10.3 — 프로젝트 스킬만 보여주던 것을 프로젝트+전역(~/.claude/skills) 합산으로 확장(현장 이슈①
// "연동된 AI의 스킬 목록이 표시 안 됨"). 이름 충돌 시 프로젝트 우선(claude 로드 순서와 동일).
// 리팩토링(2026-07-24) — scanSkillsWithOrigin(디렉터리 스캔+파일 읽기)이 렌더 본문에서 직접
// 호출되던 것을 useState+useEffect로 전환했다. 최초 버전은 useEffect 없이 useState 지연초기화만
// 썼는데(scope-critic 지적, DECISION_CHANGED) "세션 중 정적"이 "cwd 변경 무관"을 함의하지 않는다 —
// 멀티 repo 탭 전환은 같은 세션 안에서 cwd 스코프(scanSkillsWithOrigin의 프로젝트 .claude/skills
// 경로)가 바뀌므로, MetricsPanel(useEffect([cwd]) 패턴)과 동일하게 cwd 변경을 감시해 재스캔한다.
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { scanSkillsWithOrigin, type SkillInfoWithOrigin } from "../skills.js";
import { BORDER_COLOR, PANEL_TITLE_COLOR } from "./theme.js";

export function SkillsPanel({ cwd }: { cwd: string }) {
  const [skills, setSkills] = useState<SkillInfoWithOrigin[]>(() => scanSkillsWithOrigin(cwd));
  useEffect(() => {
    setSkills(scanSkillsWithOrigin(cwd));
  }, [cwd]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER_COLOR} paddingX={1}>
      <Text color={PANEL_TITLE_COLOR} bold>
        🧩 skills <Text color="gray">— 프로젝트+전역 .claude/skills · 읽기전용</Text>
      </Text>
      {skills.length === 0 ? (
        <Text color="gray">설치된 skill 없음 — 'gbc init'으로 gbc 스킬 설치</Text>
      ) : (
        skills.map((s) => (
          // wrap=truncate(0.10.3) — 설명이 랩되면 항목당 2행+중간절단으로 고정 뷰포트가 금방 차고
          // 클리핑 단면이 지저분해진다(실기검증). 항목당 정확히 1행 — 더 많은 스킬이 한 화면에 든다.
          <Text key={`${s.origin}:${s.name}`} wrap="truncate">
            <Text color="green">/{s.name}</Text>
            <Text color="gray"> [{s.origin === "project" ? "프로젝트" : "전역"}]</Text>
            {s.description ? <Text color="gray"> — {s.description.slice(0, 80)}</Text> : null}
          </Text>
        ))
      )}
    </Box>
  );
}
