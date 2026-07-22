// 0.9.3 D2 — 스플래시 안내카드. formatWelcomeCard(순수, format.ts)가 만든 행 데이터를 Ink
// Box borderStyle로 그린다. 손으로 ┌─│└를 그리지 않는 이유: Ink/yoga가 CJK 폭(string-width)을
// 이미 정확히 계산해 테두리를 맞추므로, 직접 패딩 계산을 재구현하면 한글 폭 오차로 테두리가
// 어긋나는(사용자가 실제로 지적한) 문제를 다시 만들 위험이 있다. MetricsPanel/ReposPanel/
// SkillsPanel과 동일한 테두리 관례(round·theme.BORDER_COLOR, 0.11.0 톤다운)를 따른다.
import React from "react";
import { Box } from "ink";
import { formatWelcomeCard, type CardSkill } from "../format.js";
import { Segments } from "./Segments.js";
import { BORDER_COLOR } from "./theme.js";

// 0.10.1(braintrust 2026-07-20 확정, 아티팩트 ff0eb0b1) — 사이드바(format.ts SIDEBAR_COLUMNS)와
// 동일폭 34로 통일. 이전 54(아티팩트 cb7c6b1c 장면01 사양)는 사이드바 36과 서로 달라 두 패널 폭이
// 어긋나던 것을 사용자 실측 지적으로 통일했다 — formatWelcomeCard(format.ts)의 카피도 이 폭(내부
// 30열) 예산에 맞춰 재큐레이션됨.
const CARD_WIDTH = 34;

export function WelcomeCard({
  specCount,
  deferCount,
  skills,
}: {
  specCount: number;
  deferCount: number;
  skills: CardSkill[];
}) {
  const rows = formatWelcomeCard(specCount, deferCount, skills);
  return (
    // flexShrink=0 — SubTask10(0.10.1)에서 이 카드가 Sidebar와 같은 열(column)로 상시 좌측
    // 스택에 합류하며, 그 스택이 flexGrow 대화 컬럼과 같은 행(row)에 놓인다. Sidebar.tsx가 이미
    // 겪은 것과 동일한 함정(ink Box 기본 flexShrink=1이라 "고정폭"이 실제로는 쪼그라듦, 2026-07-17
    // tmux 실측) — 같은 원인이라 같은 가드를 적용한다.
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER_COLOR} paddingX={1} width={CARD_WIDTH} flexShrink={0}>
      {rows.map((segments, i) => (
        <Segments key={i} segments={segments} />
      ))}
    </Box>
  );
}
