// 0.10.1 SubTask9 — 스플래시 헤더: GEOBUKE 워드마크+등껍질 배지+태그라인만 조립한다. 구
// SplashHero.tsx는 이 헤더에 마스코트+카드+웰컴 라인까지 한 Static 엔트리로 묶어 그렸으나,
// 카드가 좌측 상시 스택으로 이동하고 독립 스플래시 마스코트가 사이드바 것 하나로 통합되며
// (SubTask10) 헤더만 이 컴포넌트로 분리했다 — SubTask10이 이걸 Static 밖(사이드바까지 포함한
// 전체 화면 폭 기준 1회 렌더)으로 배선한다.
import React from "react";
import { Box, Text } from "ink";
import { shouldShowWordmark, renderWordmark, renderShellBadge, formatTagline, WORDMARK_GEOBUKE } from "../format.js";
import { Mascot } from "./Mascot.js";

const WORDMARK_BADGE_GAP = 4; // 워드마크-등껍질 배지 사이 여백(사용자 요청, 2026-07-14).

export function SplashHeader({ columns, version }: { columns: number; version: string }) {
  if (!shouldShowWordmark(columns)) {
    return <Text color="#166534">{formatTagline(version)}</Text>;
  }
  return (
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
  );
}
