// 0.9.0 A3a ST5 — half-block 마스코트(format.ts renderMascot 출력, 이미 ANSI 컬러 포함)를 그대로 출력.
// 각 줄이 이미 완성된 ANSI 이스케이프 문자열이라 Ink color prop 대신 원문 그대로 <Text>로 흘려보낸다
// (픽셀아트처럼 셀 단위로 색이 바뀌는 콘텐츠는 Ink의 단일-color prop으로 표현 불가 — 사전렌더 문자열
// 그대로 출력하는 것이 표준 기법, 터미널 ANSI 아트 앱들의 공통 관례).
//
// 이름은 "마스코트"지만 실제로는 범용 raw-ANSI 줄 렌더러다 — 0.9.3 D2가 워드마크 그라데이션
// (format.ts renderWordmark 출력, 행별로 다른 색의 완성 ANSI 문자열)에도 그대로 재사용한다
// (SplashHero.tsx). 겪는 문제가 동일하므로(줄마다 다른 색 = Ink 단일-color prop으로 표현 불가)
// 컴포넌트를 복제하지 않는다 — 리네임은 소비처 확장(스플래시 외 위젯 등)이 생길 때 재검토.
import React from "react";
import { Box, Text } from "ink";

export function Mascot({ lines }: { lines: string[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
