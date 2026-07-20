// 0.10.1 A3b — 외부 '+' 글리프 채움 배경 프레임(braintrust 확정, 아티팩트 ff0eb0b1). ink엔 셀
// 단위 배경 페인팅이 없어 상하 밴드('+'.repeat(cols) 텍스트 1행)+좌우 거터(고정폭 '+' 컬럼)로
// 수동 조립한다. 거터 높이는 콘텐츠 높이에 종속돼 정적으로 알 수 없으므로 measureElement로
// 중앙 콘텐츠의 실제 높이를 측정해 좌우 거터 줄 수를 동기화한다(측정→state→재렌더, 리사이즈
// 시 useWindowSize가 상위에서 columns/rows를 갱신하며 재계산 트리거 — 거터 높이=측정치라
// 피드백 루프 없음). 활성 여부·예산 판정은 순수부(format.ts computeFrameLayout)가 전담 — 이
// 컴포넌트는 그 결과를 그대로 그리기만 한다(app.tsx "판정 로직 금지" 원칙과 동일 관례).
import React, { useLayoutEffect, useRef, useState } from "react";
import { Box, Text, measureElement, type DOMElement } from "ink";
import { computeFrameLayout } from "../format.js";

const FRAME_COLOR = "#166534"; // PALETTE.D — 태그라인과 동일한 deep green. 배경 텍스처로 가라앉아 콘텐츠와 경합하지 않는다.

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
  const contentRef = useRef<DOMElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  // 의존성 배열 없이 매 렌더 후 재측정 — 대화 스트리밍·승인 박스 등 콘텐츠 높이가 바뀌는 지점이
  // 많아 개별 의존성을 나열하는 것보다 안전하다. 측정값이 이전과 같으면 React가 재렌더를 알아서
  // 스킵하므로(Object.is 비교) 무한 루프 없음.
  useLayoutEffect(() => {
    if (!layout.enabled || !contentRef.current) return;
    setContentHeight(measureElement(contentRef.current).height);
  });

  if (!layout.enabled) return <>{children}</>;

  const band = "+".repeat(columns);
  const gutterColumn = (key: string) => (
    <Box key={key} flexDirection="column">
      {Array.from({ length: contentHeight }, (_, i) => (
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
        <Box ref={contentRef} flexDirection="column">
          {children}
        </Box>
        {gutterColumn("right")}
      </Box>
      <Text color={FRAME_COLOR}>{band}</Text>
    </Box>
  );
}
