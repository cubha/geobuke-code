// 0.9.0 A3a ST5 — A-④ repos 패널(⌃R). 0.2.9 크로스-repo 레지스트리 + defer 집계를 그대로 읽는다.
// 0.10.4 ST6(개선2) — 읽기전용에서 키보드 선택 가능으로 승격: Sidebar.tsx의 커서+
// computeSidebarWindow 윈도잉 문법을 그대로 이식(전역 인덱스 관례 공유 — 0.2.5 번호 불일치 전례
// 재발 방지). 실제 커서 이동·Enter 전환·윈도잉 호출은 app.tsx(state.panel==="repos" 키 라우팅)가
// 전담하고, 이 컴포넌트는 이미 계산된 cursor를 받아 강조만 그린다(순수 표시 책임 분리 유지).
// 리팩토링(2026-07-24) — 렌더 본문에서 loadRepos()+repo당 lstatSync/existsSync/loadDefers를 직접
// 호출하던 것을 Sidebar.tsx와 동일한 패턴(useState 지연초기화+주기 폴링)으로 전환했다. 패널이 열려
// 있는 동안 스트리밍 스피너(120ms) 등 부모 리렌더가 있을 때마다 동기 파일 I/O가 반복되던 결함
// 클래스(0.9.1 detectGit·Sidebar에서 이미 두 차례 근본수정된 것과 동일)의 세 번째 재발이었다.
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadRepos } from "../../repos.js";
import { loadDefers, isClosedStatus } from "../../defer.js";
import { formatReposPanelPath, computeSidebarWindow } from "../format.js";
import { toneColor, BORDER_COLOR, PANEL_TITLE_COLOR } from "./theme.js";

const REPOS_PANEL_MAX_VISIBLE = 9;

// Sidebar.tsx REPOS_REFRESH_MS와 동일 — repos.json/defer 변경은 드문 이벤트라 주기 폴링으로 충분.
const REPOS_PANEL_REFRESH_MS = 5000;

interface ReposPanelEntry {
  path: string;
  gated: boolean;
  unresolved: number;
}

function loadReposPanelEntries(): ReposPanelEntry[] {
  return loadRepos().map((r) => {
    let gated = false;
    try {
      gated = lstatSync(r).isDirectory() && existsSync(join(r, ".gbc"));
    } catch {
      /* 부재/심링크 → gated=false */
    }
    const unresolved = gated ? loadDefers(r).filter((d) => !isClosedStatus(d.status)).length : 0;
    return { path: r, gated, unresolved };
  });
}

// contentColumns — 이 패널이 놓이는 우측 컬럼(터미널−사이드바) 가용폭. 긴 repo 경로가 ink Text
// 줄바꿈으로 │ 테두리를 뚫는 오버플로(사이드바와 동일 계열, 2026-07-17 scope-critic 지적) 방지용.
// 미지정(단독 렌더 테스트 등) 시 80열 보수적 기본값.
export function ReposPanel({
  cwd,
  contentColumns = 80,
  cursor = 0,
}: {
  cwd: string;
  contentColumns?: number;
  /** 0.10.4 ST6 — 키보드 커서(전역 인덱스, app.tsx가 소유). 패널이 단독 렌더될 때(테스트 등)는 0. */
  cursor?: number;
}) {
  const [entries, setEntries] = useState(() => loadReposPanelEntries());
  useEffect(() => {
    const id = setInterval(() => setEntries(loadReposPanelEntries()), REPOS_PANEL_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const win = computeSidebarWindow(entries.length, cursor, REPOS_PANEL_MAX_VISIBLE);
  const visible = entries.slice(win.start, win.end);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER_COLOR} paddingX={1}>
      <Text color={PANEL_TITLE_COLOR} bold>
        📁 repos <Text color="gray">— ↑/↓ 선택 · Enter 전환</Text>
      </Text>
      {entries.length === 0 ? (
        <Text color="gray">등록된 repo 없음 — 'gbc repos add'로 추가</Text>
      ) : (
        <>
          {win.aboveCount > 0 && <Text color="gray">▲ 위 {win.aboveCount}개</Text>}
          {visible.map((e, localIdx) => {
            const i = win.start + localIdx; // 전역 인덱스 — Sidebar.tsx와 동일 관례.
            const isCwd = e.path === cwd;
            const isCursor = i === cursor;
            return (
              <Text key={e.path}>
                <Text color={isCursor || isCwd ? toneColor("accent") : undefined}>
                  {isCursor ? "▸ " : isCwd ? "❯ " : "  "}
                  {formatReposPanelPath(e.path, contentColumns)}
                </Text>
                {"  "}
                <Text color={e.gated ? toneColor("accent") : "gray"}>{e.gated ? "● 활성" : "○ idle"}</Text>{"  "}
                defer <Text color={e.unresolved > 0 ? "yellow" : undefined}>{e.unresolved}</Text>
              </Text>
            );
          })}
          {win.belowCount > 0 && <Text color="gray">▼ 아래 {win.belowCount}개</Text>}
        </>
      )}
    </Box>
  );
}
