// 0.10.1 A3b — 외부 '+' 글리프 채움 배경 프레임(braintrust 확정, 아티팩트 ff0eb0b1). ink엔 셀
// 단위 배경 페인팅이 없어 상하 밴드('+'.repeat(cols) 텍스트 1행)+좌우 거터(고정폭 '+' 컬럼)로
// 수동 조립한다. 활성 여부·예산 판정은 순수부(format.ts computeFrameLayout)가 전담 — 이
// 컴포넌트는 그 결과를 그대로 그리기만 한다(app.tsx "판정 로직 금지" 원칙과 동일 관례).
//
// 2026-07-21 — 거터 높이를 measureElement 실측에서 정적 innerRows(rows−밴드2)로 전환했다.
// 실측 방식은 행 Box의 기본 alignItems:stretch가 콘텐츠 Box를 거터(=과거 측정치) 높이로
// 되늘려 "한 번 커진 측정값이 영원히 유지되는" 자기충족 고정점을 만들었고, 이것이 하단 밴드
// 위 팬텀 공백 1행의 근본원인이었다(첫 프레임 폴백 높이로 오염된 측정치가 콘텐츠 축소 후에도
// 잔존). Frame은 전체화면 전용이라 내부 높이가 정적으로 확정 가능 — 측정 자체를 제거해 이
// 결함 클래스(팬텀 행·특정 폭 무한 리렌더)를 원천 차단한다. 콘텐츠가 innerRows보다 짧으면
// 남는 공간은 app.tsx의 flexGrow '+' 채움 Box가 흡수한다.
import React from "react";
import { Box, Text } from "ink";
import { computeFrameLayout } from "../format.js";
import { FRAME_COLOR } from "./theme.js";

export function Frame({
  columns,
  rows,
  children,
}: {
  columns: number;
  rows: number;
  children: React.ReactNode;
}) {
  const layout = computeFrameLayout(columns, rows);

  if (!layout.enabled) return <>{children}</>;

  const band = "+".repeat(columns);
  const gutterColumn = (key: string) => (
    <Box key={key} flexDirection="column">
      {Array.from({ length: layout.innerRows }, (_, i) => (
        <Text key={i} color={FRAME_COLOR}>
          {"+".repeat(layout.gutterColumns)}
        </Text>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Text color={FRAME_COLOR}>{band}</Text>
      <Box flexDirection="row">
        {gutterColumn("left")}
        {/* width 강제 필수 — yoga 기본은 자연폭 수축이라 콘텐츠가 innerColumns보다 좁으면
            우측 거터가 콘텐츠에 붙어 상하 밴드 우측 끝과 어긋난다(사용자 실기 보고, 2026-07-21).
            height도 innerRows로 고정 — 자식이 짧아도 거터와 항상 같은 높이라 어긋남이 없다. */}
        <Box flexDirection="column" width={layout.innerColumns} height={layout.innerRows}>
          {children}
        </Box>
        {gutterColumn("right")}
      </Box>
      <Text color={FRAME_COLOR}>{band}</Text>
    </Box>
  );
}
