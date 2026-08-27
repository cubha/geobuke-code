// 0.10.4 ST7(개선3-a) — '?' 단축키 도움말 패널. 기존 패널 3종(metrics/repos/skills)과 동일한 토글
// 시스템(model.ts TOGGLE_PANEL/CLOSE_PANEL)에 얹힌 네 번째 패널 — 정적 텍스트라 별도 상태 없음.
// 0.13.1 T-1 — 키맵 데이터는 format.ts SHORTCUT_ROWS(SHORTCUT_REGISTRY 파생)를 단일 소스로 쓴다.
// 이 파일이 먼저 format.ts를 import하던 기존 방향(computePanelCapacity 등)을 그대로 따른 것 —
// 반대 방향(format.ts가 HelpPanel을 import)은 ESM 순환이 된다.
import React from "react";
import { Box, Text } from "ink";
import { BORDER_COLOR, PANEL_TITLE_COLOR } from "./theme.js";
import { computePanelCapacity, computeSidebarWindow, SHORTCUT_ROWS } from "../format.js";

export function HelpPanel({ availableRows }: { availableRows?: number } = {}) {
  const maxVisible = computePanelCapacity(availableRows ?? 20, SHORTCUT_ROWS.length);
  const win = computeSidebarWindow(SHORTCUT_ROWS.length, 0, maxVisible);
  const visible = SHORTCUT_ROWS.slice(win.start, win.end);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER_COLOR} paddingX={1}>
      <Text color={PANEL_TITLE_COLOR} bold>
        ❓ 단축키 도움말
      </Text>
      {win.aboveCount > 0 && <Text color="gray">▲ 위 {win.aboveCount}개</Text>}
      {visible.map(([key, desc]) => (
        <Text key={key} wrap="truncate">
          <Text color="green">{key.padEnd(11)}</Text>
          <Text color="gray">{desc}</Text>
        </Text>
      ))}
      {win.belowCount > 0 && <Text color="gray">▼ 아래 {win.belowCount}개</Text>}
    </Box>
  );
}
