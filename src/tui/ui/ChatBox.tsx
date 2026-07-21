// 0.10.1 SubTask2 — 대화창 박스 상주(최종시안 ff0eb0b1, braintrust 선결조건 ⓐⓑⓓ). ink <Static>을
// 완전히 대체한다: scrollback 전량을 wrapSegmentLine(표시폭 기준)으로 사전 랩해 시각행 배열을 만들고,
// computeChatViewport로 스크롤 위치에 맞는 슬라이스만 렌더한다. Static을 부분적으로라도 남기지 않는
// 이유는 win32에서 키입력마다 O(전체대화) 재출력이 재발하고, Static 자체가 컬럼 레이아웃 안에 갇히지
// 않기 때문(0.10.0 A3b 실측 근거, "테두리만" 절충 불성립 확정).
//
// 높이 계약: viewportRows(=대화 콘텐츠에 배정된 고정 행수)는 app.tsx가 computeChatRegionRows로
// 산정해 그대로 넘겨준다. 대화가 짧으면 남는 자리를 빈 줄로 채우고(padCount), 길면 정확히
// viewportRows만큼만 슬라이스한다 — 어느 쪽이든 이 컴포넌트가 그리는 메시지 뷰포트 행수는 항상
// 동일해 패널/승인 전환 시에도 박스 테두리가 흔들리지 않는다(ⓓ). 단 panelNode(metrics/repos/skills
// 패널)는 각자 자기 콘텐츠 높이대로 그려진다 — 이 컴포넌트가 그 내부까지 강제로 잘라내지는 않는다
// (ink Box height는 레이아웃 힌트일 뿐 실제 출력 클리핑이 아니다 — 패널이 viewportRows보다 길면
// 박스 높이가 그만큼 늘어나는 게 알려진 한계다. 기존 0.10.0도 동일 한계를 이미 갖고 있었다).
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { wrapSegmentLine, computeChatViewport, WELCOME_LINE, type TextSegment } from "../format.js";
import { toneColor } from "./theme.js";

export interface ChatEntry {
  id: number;
  segments: TextSegment[];
}

export function ChatBox({
  innerWidth,
  viewportRows,
  entries,
  scrollOffset,
  showWelcome,
  panelNode,
  streamingNode,
  children,
}: {
  /** 메시지 텍스트를 랩할 표시폭(문자 단위, string-width 기준) — 박스 테두리·패딩을 뺀 순수 콘텐츠 폭. */
  innerWidth: number;
  /** 대화 뷰포트에 배정된 고정 행수(app.tsx가 computeChatRegionRows로 산정). */
  viewportRows: number;
  entries: ChatEntry[];
  scrollOffset: number;
  showWelcome: boolean;
  /** metrics/repos/skills 패널이 열려있으면 대화 뷰포트를 이걸로 완전히 대체한다. */
  panelNode?: React.ReactNode;
  /** 스트리밍 프리뷰+스피너 — 이미 렌더된 노드(계산은 app.tsx가 기존 로직 그대로 소유). */
  streamingNode?: React.ReactNode;
  /** 하단 고정 영역: 입력창/승인박스 + 게이트줄 + statusline. */
  children: React.ReactNode;
}) {
  const wrapped = useMemo(() => {
    const lines: TextSegment[][] = [];
    if (showWelcome) lines.push(...wrapSegmentLine([{ text: WELCOME_LINE, tone: "accent" }], innerWidth));
    for (const e of entries) lines.push(...wrapSegmentLine(e.segments, innerWidth));
    return lines;
  }, [entries, showWelcome, innerWidth]);

  const contentRows = Math.max(1, viewportRows);
  const viewport = computeChatViewport(wrapped.length, contentRows, scrollOffset);
  const visible = wrapped.slice(viewport.start, viewport.end);
  const padCount = Math.max(0, contentRows - visible.length);

  const indicatorParts: string[] = [];
  if (viewport.aboveCount > 0) indicatorParts.push(`▲ 위 ${viewport.aboveCount}줄`);
  if (viewport.belowCount > 0) indicatorParts.push(`▼ 아래 ${viewport.belowCount}줄`);
  const indicatorText = indicatorParts.join(" · ");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} flexGrow={1}>
      {/* 인디케이터는 항상 1행 예약(내용 없어도 공백) — 스크롤 시작/종료로 이 행이 나타났다 사라지면
          그 아래 전체가 한 줄씩 밀려 보이는 깜빡임이 생긴다. */}
      <Text color="gray">{indicatorText || " "}</Text>
      <Box flexDirection="column">
        {panelNode ?? (
          <>
            {visible.map((line, i) => (
              <Text key={i}>
                {line.length === 0 ? " " : line.map((seg, j) => <Text key={j} color={toneColor(seg.tone)}>{seg.text}</Text>)}
              </Text>
            ))}
            {Array.from({ length: padCount }, (_, i) => (
              <Text key={`pad-${i}`}> </Text>
            ))}
          </>
        )}
      </Box>
      {streamingNode}
      {children}
    </Box>
  );
}
