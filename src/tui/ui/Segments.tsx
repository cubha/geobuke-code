// 0.9.0 A3a ST5 — TextSegment[](format.ts)를 Ink 줄로 렌더.
import React from "react";
import { Text } from "ink";
import type { TextSegment } from "../format.js";
import { toneColor } from "./theme.js";

/** 세그먼트 사이 구분자 기본값. 0.11.2 — 포커스 모드 statusline 전체폭 패딩(padSegmentsToWidth)이
 *  이 폭까지 정확히 계산해야 해서 상수로 노출한다(각자 " · "를 하드코딩하면 drift). */
export const SEGMENT_SEP = " · ";

export function Segments({
  segments,
  sep = SEGMENT_SEP,
  pad = "",
}: {
  segments: TextSegment[];
  sep?: string;
  /** 0.11.2 ST5 — 줄 끝에 **구분자 없이** 덧붙일 공백(format.ts computeSegmentsPad 산출).
   *  포커스 모드에서 이 줄이 화면 마지막 렌더 행이 되는데, ink가 마지막 행엔 erase-to-EOL을
   *  emit하지 않아 직전 프레임의 '+' 밴드 꼬리가 남는다. 색을 입혀 그리는 게 핵심 — 순수 공백은
   *  ink가 줄 끝에서 잘라내 패딩이 통째로 사라진다(실측 확인). */
  pad?: string;
}) {
  return (
    <Text>
      {segments.map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 ? sep : ""}
          <Text color={toneColor(s.tone)}>{s.text}</Text>
        </React.Fragment>
      ))}
      {pad ? <Text color={toneColor("dim")}>{pad}</Text> : null}
    </Text>
  );
}
