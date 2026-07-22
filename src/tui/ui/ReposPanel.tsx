// 0.9.0 A3a ST5 — A-④ repos 패널(⌃R). 0.2.9 크로스-repo 레지스트리 + defer 집계를 그대로 읽는다
// (읽기전용 — cmdRepos의 health-check까지는 재현하지 않음, 목록+defer 카운트만).
import React from "react";
import { Box, Text } from "ink";
import { lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadRepos } from "../../repos.js";
import { loadDefers, isClosedStatus } from "../../defer.js";
import { formatReposPanelPath } from "../format.js";
import { BORDER_COLOR, PANEL_TITLE_COLOR } from "./theme.js";

// contentColumns — 이 패널이 놓이는 우측 컬럼(터미널−사이드바) 가용폭. 긴 repo 경로가 ink Text
// 줄바꿈으로 │ 테두리를 뚫는 오버플로(사이드바와 동일 계열, 2026-07-17 scope-critic 지적) 방지용.
// 미지정(단독 렌더 테스트 등) 시 80열 보수적 기본값.
export function ReposPanel({ cwd, contentColumns = 80 }: { cwd: string; contentColumns?: number }) {
  const repos = loadRepos();

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER_COLOR} paddingX={1}>
      <Text color={PANEL_TITLE_COLOR} bold>
        📁 repos <Text color="gray">— ~/.gbc/repos.json · 읽기전용</Text>
      </Text>
      {repos.length === 0 ? (
        <Text color="gray">등록된 repo 없음 — 'gbc repos add'로 추가</Text>
      ) : (
        repos.map((r) => {
          let gated = false;
          try {
            gated = lstatSync(r).isDirectory() && existsSync(join(r, ".gbc"));
          } catch {
            /* 부재/심링크 → gated=false */
          }
          const unresolved = gated ? loadDefers(r).filter((d) => !isClosedStatus(d.status)).length : 0;
          const isCwd = r === cwd;
          return (
            <Text key={r}>
              <Text color={isCwd ? "green" : undefined}>{isCwd ? "❯ " : "  "}{formatReposPanelPath(r, contentColumns)}</Text>{"  "}
              <Text color={gated ? "green" : "gray"}>{gated ? "● 활성" : "○ idle"}</Text>{"  "}
              defer <Text color={unresolved > 0 ? "yellow" : undefined}>{unresolved}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}
