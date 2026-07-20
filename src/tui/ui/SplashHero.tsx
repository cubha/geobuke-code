// 0.9.3 D2 — 스플래시 히어로: 워드마크+태그라인+마스코트/카드 2컬럼 병치를 폭에 따라 3단으로
// 조립한다(승인 시안, 아티팩트 cb7c6b1c 장면01). 기존 구현은 워드마크·마스코트·카드를 app.tsx가
// 각각 독립된 Static 엔트리로 나열해 병치·세로중앙정렬·여백이 전부 빠진 상태였다(사용자 실사용
// 지적, 2026-07-14) — 이 컴포넌트가 하나의 Static 엔트리로 조립을 대신한다.
// 0.10.1 — 워드마크 노출(showWordmark)과 2컬럼 병치(twoColumn)가 selectHeroLayout(format.ts)의
// 독립 불리언 2개로 분리됐다(braintrust 확정). 이전엔 단일 SPLASH_HERO_MIN_COLUMNS 하나로 "96열
// 미만이면 워드마크째 생략"했으나, 이제 워드마크는 더 좁은 폭(72열)부터 항상 상단에 뜬다.
import React from "react";
import { Box, Text } from "ink";
import {
  selectMascot,
  renderMascot,
  renderWordmark,
  renderShellBadge,
  formatTagline,
  selectHeroLayout,
  WORDMARK_GEOBUKE,
  WELCOME_LINE,
  type CardSkill,
} from "../format.js";
import { Mascot } from "./Mascot.js";
import { WelcomeCard } from "./WelcomeCard.js";

const MASCOT_CARD_GAP = 6; // 시안 여백 사양 — 마스코트↔카드 사이 6칸.
const HERO_LEFT_MARGIN = 3; // 시안 여백 사양 — 좌측 여백 3칸.
// 워드마크 위 여백 = 태그라인↔마스코트/카드 사이 여백(marginTop={2})과 동일값 — 대칭 보장.
const HERO_TOP_MARGIN = 2;
const WORDMARK_BADGE_GAP = 4; // 워드마크-등껍질 배지 사이 여백(사용자 요청, 2026-07-14).

export function SplashHero({
  columns,
  version,
  specCount,
  deferCount,
  skills,
}: {
  columns: number;
  version: string;
  specCount: number;
  deferCount: number;
  skills: CardSkill[];
}) {
  const mascotLines = renderMascot(selectMascot(columns));
  const card = <WelcomeCard specCount={specCount} deferCount={deferCount} skills={skills} />;
  // 웰컴 라인(폭 무관 공통) — 카드 아래 1줄 띄우고, 이 hero는 Static(1회 커밋)이라 marginBottom이
  // "웰컴↔입력박스 2줄" 여백을 세션 내내 재적용하지 않고 스플래시 직후에만 정확히 남긴다.
  const welcome = (
    <Box marginTop={1} marginBottom={2}>
      <Text color="green">{WELCOME_LINE}</Text>
    </Box>
  );

  const { showWordmark, twoColumn } = selectHeroLayout(columns);

  // 워드마크 위 여백은 태그라인↔마스코트/카드 사이 여백(HERO_TOP_MARGIN=마스코트+카드 marginTop과
  // 동일값)과 대칭되도록 맞춘다 — 기존엔 위 여백이 0이라 워드마크가 화면 상단에 바짝 붙어 비대칭이었음
  // (사용자 실사용 지적, 2026-07-14). Mascot은 이름과 달리 "사전 컬러링된 ANSI 줄 배열을 그대로
  // 출력"하는 범용 컴포넌트라 워드마크 그라데이션 렌더에도 재사용한다(Mascot.tsx 헤더 주석 참조).
  const header = showWordmark ? (
    <>
      <Box flexDirection="row">
        <Mascot lines={renderWordmark()} />
        <Box width={WORDMARK_BADGE_GAP} />
        <Mascot lines={renderShellBadge()} />
      </Box>
      <Box width={WORDMARK_GEOBUKE[0].length} justifyContent="flex-end">
        <Text color="#166534">{formatTagline(version)}</Text>
      </Box>
    </>
  ) : (
    <Text color="#166534">{formatTagline(version)}</Text>
  );

  // twoColumn=false: 마스코트(C4 미니 또는 S2)+카드 세로 스택. 워드마크가 뜨는 [72,73) 좁은
  // 중간 구간에서는 header와의 대칭 여백을 유지하기 위해 marginTop=2(showWordmark일 때만).
  const body = twoColumn ? (
    <Box flexDirection="row" alignItems="center" marginTop={2}>
      <Mascot lines={mascotLines} />
      <Box width={MASCOT_CARD_GAP} />
      {card}
    </Box>
  ) : (
    <Box flexDirection="column" marginTop={showWordmark ? 2 : 0}>
      <Mascot lines={mascotLines} />
      {card}
    </Box>
  );

  return (
    <Box flexDirection="column" marginLeft={HERO_LEFT_MARGIN} marginTop={HERO_TOP_MARGIN}>
      {header}
      {body}
      {welcome}
    </Box>
  );
}
