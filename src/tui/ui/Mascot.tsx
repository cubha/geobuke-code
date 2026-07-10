// 0.9.0 A3a ST5 — half-block 마스코트(format.ts renderMascot 출력, 이미 ANSI 컬러 포함)를 그대로 출력.
// 각 줄이 이미 완성된 ANSI 이스케이프 문자열이라 Ink color prop 대신 원문 그대로 <Text>로 흘려보낸다
// (픽셀아트처럼 셀 단위로 색이 바뀌는 콘텐츠는 Ink의 단일-color prop으로 표현 불가 — 사전렌더 문자열
// 그대로 출력하는 것이 표준 기법, 터미널 ANSI 아트 앱들의 공통 관례).
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
