// 0.10.4 ST5 — 개선1(입력창 '/' 스킬 드롭다운) 렌더. Sidebar.tsx/ReposPanel.tsx와 동일한 커서+
// computeSidebarWindow 윈도잉 문법을 재사용한다(신규 시각 언어 없음 — Ground Truth 부재 프로젝트라
// 기존 패널 관례를 그대로 따름, planner 설계 명세).
import React from "react";
import { Box, Text } from "ink";
import type { SkillInfoWithOrigin } from "../skills.js";
import { toneColor, BORDER_COLOR } from "./theme.js";

export function SlashDropdown({
  items,
  aboveCount,
  belowCount,
  cursorIndexInWindow,
}: {
  /** 이미 윈도잉된(computeSidebarWindow) 슬라이스 — 이 컴포넌트는 스크롤 계산을 하지 않는다. */
  items: SkillInfoWithOrigin[];
  aboveCount: number;
  belowCount: number;
  /** items 배열 내 커서 위치(로컬 인덱스) — 음수면 강조 없음(후보 0개). */
  cursorIndexInWindow: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER_COLOR} paddingX={1}>
      {aboveCount > 0 && <Text color="gray">▲ 위 {aboveCount}개</Text>}
      {items.length === 0 ? (
        <Text color="gray">일치하는 스킬 없음 — 그대로 Enter 제출 가능</Text>
      ) : (
        items.map((s, i) => (
          <Text key={`${s.origin}:${s.name}`} wrap="truncate">
            <Text color={i === cursorIndexInWindow ? toneColor("accent") : undefined}>
              {i === cursorIndexInWindow ? "▸ " : "  "}
            </Text>
            <Text color={toneColor("accent")}>/{s.name}</Text>
            <Text color="gray"> [{s.origin === "project" ? "프로젝트" : "전역"}]</Text>
            {s.description ? <Text color="gray"> — {s.description.slice(0, 60)}</Text> : null}
          </Text>
        ))
      )}
      {belowCount > 0 && <Text color="gray">▼ 아래 {belowCount}개</Text>}
    </Box>
  );
}
