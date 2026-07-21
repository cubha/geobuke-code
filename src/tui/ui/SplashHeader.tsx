// 0.10.1 SubTask9 — 스플래시 헤더: GEOBUKE 워드마크+등껍질 배지+태그라인만 조립한다. 구
// SplashHero.tsx는 이 헤더에 마스코트+카드+웰컴 라인까지 한 Static 엔트리로 묶어 그렸으나,
// 카드가 좌측 상시 스택으로 이동하고 독립 스플래시 마스코트가 사이드바 것 하나로 통합되며
// (SubTask10) 헤더만 이 컴포넌트로 분리했다 — SubTask10이 이걸 Static 밖(사이드바까지 포함한
// 전체 화면 폭 기준 1회 렌더)으로 배선한다.
// 2026-07-21 — 루트를 column Box로 감싼다: ink Box 기본 flexDirection은 row라, Fragment로
// 반환하면 부모(app.tsx 히어로 Box)가 워드마크와 태그라인을 가로로 병치해 태그라인이
// 워드마크 오른쪽에 붙던 실기 결함이 있었다. 태그라인은 시안(ff0eb0b1)의 '초회노출' 배지와
// 동일한 노란배경 배지 스타일로 워드마크 하단에 렌더한다(사용자 지시).
// 2026-07-21(2차) — 외곽 '+' 프레임이 테두리뿐 아니라 Title Area 내부 배경까지 이어 보이도록,
// 글리프가 없는 모든 칸(좌측 여백·워드마크-배지 간격·우측 잔여폭·상단 여백행·태그라인 잔여폭)을
// 프레임과 동일한 딥그린 '+'로 채운다(사용자 요청 — "외곽선뿐 아니라 내부도"). 이 여백 관리를
// app.tsx의 marginLeft/marginTop Box(빈 공백)에서 이 컴포넌트 내부의 명시적 '+' 열로 옮겼다 —
// margin은 뭘로도 채울 수 없는 진짜 공백이라, 채우려면 실제 문자를 그려야 한다.
import React from "react";
import { Text } from "ink";
import stringWidth from "string-width";
import {
  shouldShowWordmark,
  renderWordmark,
  renderShellBadge,
  formatTagline,
  WORDMARK_GEOBUKE,
  SHELL_BADGE_GLYPH,
} from "../format.js";
import { FRAME_COLOR } from "./theme.js";

const WORDMARK_BADGE_GAP = 4; // 워드마크-등껍질 배지 사이 여백(사용자 요청, 2026-07-14).
const TAGLINE_BADGE_BG = "#e0ab4a"; // 시안 .note.once 배경 — 초회노출 주석 배지와 동일 톤.
const TAGLINE_BADGE_FG = "#24190a"; // 시안 .note.once 글자색.

/** 글리프 없는 칸을 프레임과 동일한 '+'로 채운다 — count<=0이면 아무것도 렌더하지 않는다(빈 Text로 열을 낭비하지 않음).
 * 색은 Frame.tsx와 theme.ts FRAME_COLOR를 공유(2026-07-21 scope-critic 지적 — 각자 하드코딩하면 drift). */
function PlusFill({ count }: { count: number }) {
  if (count <= 0) return null;
  return <Text color={FRAME_COLOR}>{"+".repeat(count)}</Text>;
}

function taglineBadgeText(version: string): string {
  return ` ${formatTagline(version)} `; // 좌우 1칸 여백 포함(배지 형태).
}

export function SplashHeader({
  columns,
  version,
  leftMargin = 0,
  topMarginRows: topMarginRowCount = 0,
}: {
  columns: number;
  version: string;
  leftMargin?: number;
  /** 상단 여백 행수(app.tsx HERO_TOP_MARGIN) — 전체폭 '+' 행으로 채운다. app.tsx가 더 이상
   * marginTop(빈 공백)을 쓰지 않고, 이 prop을 통해 단일 소스(HERO_TOP_MARGIN)를 그대로 물려받는다. */
  topMarginRows?: number;
}) {
  const topMarginRows = (
    <>
      {Array.from({ length: topMarginRowCount }, (_, i) => (
        <Text key={i}>
          <PlusFill count={columns} />
        </Text>
      ))}
    </>
  );

  const taglineText = taglineBadgeText(version);
  const taglineWidth = stringWidth(taglineText); // CJK 혼입이라 .length 대신 표시폭 기준 필수.
  const taglineTrailing = Math.max(0, columns - leftMargin - taglineWidth);
  const taglineRow = (
    <Text>
      <PlusFill count={leftMargin} />
      <Text backgroundColor={TAGLINE_BADGE_BG} color={TAGLINE_BADGE_FG}>
        {taglineText}
      </Text>
      <PlusFill count={taglineTrailing} />
    </Text>
  );

  if (!shouldShowWordmark(columns)) {
    return (
      <>
        {topMarginRows}
        {taglineRow}
      </>
    );
  }

  const wordmarkLines = renderWordmark();
  const badgeLines = renderShellBadge();
  const wordmarkWidth = WORDMARK_GEOBUKE[0].length; // ASCII 아트라 .length=표시폭(기존 전제, SPLASH_WORDMARK_MIN_COLUMNS와 동일 관례).
  const badgeWidth = SHELL_BADGE_GLYPH[0].length;
  const trailing = Math.max(0, columns - leftMargin - wordmarkWidth - WORDMARK_BADGE_GAP - badgeWidth);

  return (
    <>
      {topMarginRows}
      {wordmarkLines.map((line, i) => (
        <Text key={i}>
          <PlusFill count={leftMargin} />
          {line}
          {/* 2026-07-21(3차, 사용자 지시) — 워드마크-배지 사이는 '+' 채움에서 제외하고 원래
              공백으로 되돌린다. 둘을 한 로고 lockup으로 붙여 보이게 하려는 원래 여백 의도를
              보존(사용자 요청, 2026-07-14)하되, 그 외 모든 잔여 공간은 계속 '+'로 채운다. */}
          {" ".repeat(WORDMARK_BADGE_GAP)}
          {badgeLines[i]}
          <PlusFill count={trailing} />
        </Text>
      ))}
      <Text>
        <PlusFill count={columns} />
      </Text>
      {taglineRow}
    </>
  );
}
