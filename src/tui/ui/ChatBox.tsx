// 0.10.1 SubTask2 — 대화창 박스 상주(최종시안 ff0eb0b1, braintrust 선결조건 ⓐⓑⓓ). ink <Static>을
// 완전히 대체한다: scrollback 전량을 wrapSegmentLine(표시폭 기준)으로 사전 랩해 시각행 배열을 만들고,
// computeChatViewport로 스크롤 위치에 맞는 슬라이스만 렌더한다. Static을 부분적으로라도 남기지 않는
// 이유는 win32에서 키입력마다 O(전체대화) 재출력이 재발하고, Static 자체가 컬럼 레이아웃 안에 갇히지
// 않기 때문(0.10.0 A3b 실측 근거, "테두리만" 절충 불성립 확정).
//
// 높이 계약(0.10.3 강화 — 2026-07-22 현장 4이슈): 박스 전체(totalRows)와 콘텐츠 영역(viewportRows)
// 둘 다 고정이다. 기존엔 ⓐ 스트리밍 프리뷰/스피너가 viewportRows 예산 "밖에" 추가 렌더됐고
// ⓑ panelNode가 자연 높이로 그려져(짧으면 섹션 축소·길면 박스 성장) ⓒ \n 포함 엔트리의 실제
// 렌더 행수가 계산과 어긋나 — 셋 다 프레임 총높이가 터미널 행수를 넘는 순간 알트스크린이 이전
// 프레임을 못 지워 타이틀 잘림·메시지 잔상이 생겼다(사용자 스크린샷 재현). 지금은:
//  - 스트리밍 프리뷰가 대화 시각행 윈도우 "안에서" 스크롤백 뒤에 이어져 함께 윈도잉된다(추가 행 0).
//  - 스피너는 항상 예약된 인디케이터 행(1행)에 병합 표시된다(추가 행 0).
//  - 콘텐츠 영역은 height 고정+overflow hidden — panelNode가 길면 잘리고 짧으면 빈 공간 유지
//    (섹션 높이 불변). 외곽 Box도 totalRows로 고정해 어떤 자식 성장도 프레임을 밀지 못한다.
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { wrapSegmentLine, computeChatViewport, WELCOME_LINE, type TextSegment } from "../format.js";
import { toneColor, BORDER_COLOR } from "./theme.js";

export interface ChatEntry {
  id: number;
  segments: TextSegment[];
}

export function ChatBox({
  innerWidth,
  viewportRows,
  totalRows,
  entries,
  scrollOffset,
  showWelcome,
  streamingText,
  spinnerText,
  panelNode,
  children,
}: {
  /** 메시지 텍스트를 랩할 표시폭(문자 단위, string-width 기준) — 박스 테두리·패딩을 뺀 순수 콘텐츠 폭. */
  innerWidth: number;
  /** 대화 뷰포트에 배정된 고정 행수(app.tsx가 computeChatRegionRows−크롬−하단부로 산정). */
  viewportRows: number;
  /** 박스 전체 고정 높이(테두리 포함) — 자식이 어떤 이유로 더 크게 그려져도 이 높이를 절대 넘지 않는다. */
  totalRows: number;
  entries: ChatEntry[];
  scrollOffset: number;
  showWelcome: boolean;
  /** 스트리밍 중 partial 텍스트 — 대화 시각행 윈도우 안에서 스크롤백 뒤에 이어 렌더된다(0.10.3). */
  streamingText?: string;
  /** 스트리밍 스피너 1줄 — 인디케이터 예약 행에 병합 표시된다(별도 행 소비 없음, 0.10.3). */
  spinnerText?: string;
  /** metrics/repos/skills 패널이 열려있으면 대화 뷰포트를 이걸로 완전히 대체한다(고정 높이 영역). */
  panelNode?: React.ReactNode;
  /** 하단 고정 영역: 입력창/승인박스 + 게이트줄 + statusline. */
  children: React.ReactNode;
}) {
  const wrapped = useMemo(() => {
    const lines: TextSegment[][] = [];
    if (showWelcome) lines.push(...wrapSegmentLine([{ text: WELCOME_LINE, tone: "accent" }], innerWidth));
    for (const e of entries) lines.push(...wrapSegmentLine(e.segments, innerWidth));
    return lines;
  }, [entries, showWelcome, innerWidth]);

  // 스트리밍 프리뷰도 동일한 표시폭 랩을 거쳐야 행수 계산이 정확하다 — 구 tailLines(논리줄 기준)는
  // 소프트랩 오차를 보수적 여유값에 떠넘겼는데, 그 여유값(PREVIEW_RESERVED_ROWS)이 대화창 박스
  // 예산과 이중계산되며 초과의 주범이 됐다.
  const streamWrapped = useMemo(
    () => (streamingText ? wrapSegmentLine([{ text: streamingText, tone: "plain" }], innerWidth) : []),
    [streamingText, innerWidth],
  );

  const contentRows = Math.max(1, viewportRows);
  const total = wrapped.length + streamWrapped.length;
  const viewport = computeChatViewport(total, contentRows, scrollOffset);
  const visible: TextSegment[][] = [];
  for (let i = viewport.start; i < viewport.end; i++) {
    visible.push(i < wrapped.length ? wrapped[i] : streamWrapped[i - wrapped.length]);
  }

  const indicatorParts: string[] = [];
  if (spinnerText) indicatorParts.push(spinnerText);
  if (viewport.aboveCount > 0) indicatorParts.push(`▲ 위 ${viewport.aboveCount}줄`);
  if (viewport.belowCount > 0) indicatorParts.push(`▼ 아래 ${viewport.belowCount}줄`);
  const indicatorText = indicatorParts.join(" · ");

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={BORDER_COLOR}
      paddingX={1}
      flexGrow={1}
      height={totalRows}
      overflow="hidden"
    >
      {/* 인디케이터는 항상 1행 예약(내용 없어도 공백) — 스크롤 시작/종료·스피너 등장으로 이 행이
          나타났다 사라지면 그 아래 전체가 한 줄씩 밀려 보이는 깜빡임이 생긴다. 스피너 병합 시에도
          1행 클램프(overflow hidden)로 랩 성장까지 차단한다. */}
      <Box height={1} overflow="hidden" flexShrink={0}>
        <Text color="gray" wrap="truncate">{indicatorText || " "}</Text>
      </Box>
      {/* 콘텐츠 영역 고정 높이 — 패널이 짧아도 섹션이 줄지 않고, 길면 하단이 잘린다(섹션영역 항시
          고정, 사용자 확정 계약 2026-07-22). 대화 시각행은 위 windowing이 이미 정확히 contentRows
          이하로 슬라이스하므로 이 클램프는 panelNode·계산 오차의 최종 방어선이다. */}
      <Box flexDirection="column" height={contentRows} overflow="hidden" flexShrink={0}>
        {panelNode ??
          visible.map((line, i) => (
            <Text key={i}>
              {line.length === 0 ? " " : line.map((seg, j) => <Text key={j} color={toneColor(seg.tone)}>{seg.text}</Text>)}
            </Text>
          ))}
      </Box>
      {children}
    </Box>
  );
}
