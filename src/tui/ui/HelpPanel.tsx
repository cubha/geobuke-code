// 0.10.4 ST7(개선3-a) — '?' 단축키 도움말 패널. 기존 패널 3종(metrics/repos/skills)과 동일한 토글
// 시스템(model.ts TOGGLE_PANEL/CLOSE_PANEL)에 얹힌 네 번째 패널 — 정적 텍스트라 별도 상태 없음.
import React from "react";
import { Box, Text } from "ink";
import { BORDER_COLOR, PANEL_TITLE_COLOR } from "./theme.js";

const SHORTCUT_ROWS: readonly [string, string][] = [
  ["Alt+1..9", "repo 전환/opt-in"],
  ["Alt+W", "현재 repo opt-out"],
  ["Alt+M", "메트릭 패널"],
  ["Alt+R", "repos 패널(↑/↓·Enter)"],
  ["Alt+S", "skills 패널"],
  ["Alt+T", "타이틀 full/mini 전환"],
  ["Tab", "사이드바 포커스 토글"],
  ["PgUp/PgDn", "대화창 스크롤"],
  ["Esc", "스트리밍 중단 · 패널/드롭다운 닫기"],
  ["Ctrl+C ×2", "종료(2초 내 재입력)"],
  ["Shift+↵", "입력창 개행"],
  ["/", "스킬 드롭다운(↑/↓·Enter/Tab 완성)"],
  ["?", "이 도움말(입력창 비어있을 때)"],
];

export function HelpPanel() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER_COLOR} paddingX={1}>
      <Text color={PANEL_TITLE_COLOR} bold>
        ❓ 단축키 도움말
      </Text>
      {SHORTCUT_ROWS.map(([key, desc]) => (
        <Text key={key} wrap="truncate">
          <Text color="green">{key.padEnd(11)}</Text>
          <Text color="gray">{desc}</Text>
        </Text>
      ))}
    </Box>
  );
}
