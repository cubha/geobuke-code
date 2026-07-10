// 0.9.0 A3a ST5 — TextSegment[](format.ts)를 Ink 줄로 렌더.
import React from "react";
import { Text } from "ink";
import type { TextSegment } from "../format.js";
import { toneColor } from "./theme.js";

export function Segments({ segments, sep = " · " }: { segments: TextSegment[]; sep?: string }) {
  return (
    <Text>
      {segments.map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 ? sep : ""}
          <Text color={toneColor(s.tone)}>{s.text}</Text>
        </React.Fragment>
      ))}
    </Text>
  );
}
