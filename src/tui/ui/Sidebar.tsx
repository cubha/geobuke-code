// 0.10.0 A3b ST10/ST11 — 터틀 덱 좌측 상시 사이드바(고정폭). 기존 ReposPanel(⌃R 토글 오버레이, 게이트
// 설치 여부 표시)과는 구조적으로 분리된 신규 컴포넌트다 — 토글 패널 시스템(model.ts Panel 타입)을
// 건드리지 않고 항상 보이는 별도 레이아웃 축으로 추가해 기존 ⌃M/⌃R/⌃S 동작에 회귀가 없다.
// ST11: opt-in 탭(tabs.ts TabRegistry)의 세션 상태를 formatTabStatusGlyph(ST9 어휘)로 표시하고,
// 등록됐지만 아직 opt-in 안 된 repo는 Ctrl+N 힌트만 보여준다.
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { loadRepos } from "../../repos.js";
import { selectMascot, renderMascot, formatTabStatusGlyph, formatSidebarRepoPath, SIDEBAR_COLUMNS } from "../format.js";
import { toneColor } from "./theme.js";
import { Mascot } from "./Mascot.js";
import type { TabRegistry } from "../tabs.js";

// 사이드바 폭(36)은 SPLASH_WIDE_MIN_COLUMNS(60) 미만이라 항상 미니 마스코트(C4)를 쓴다(selectMascot이
// 이미 60열 미만이면 C4를 고름). SIDEBAR_COLUMNS는 상수라 이 값은 절대 안 바뀐다 — 모듈 로드 시
// 1회만 계산해 컴포넌트가 리렌더될 때마다(=매 키입력마다, App이 상태를 dispatch하므로) 다시
// 계산하지 않는다.
const SIDEBAR_MASCOT_LINES = renderMascot(selectMascot(SIDEBAR_COLUMNS));

// repos.json은 'gbc repos add/remove' CLI로만 바뀌는 드문 이벤트라 실시간 반응이 필요 없다 —
// 주기적 폴링으로 충분(과함).
const REPOS_REFRESH_MS = 5000;

export function Sidebar({ cwd, tabs }: { cwd: string; tabs: TabRegistry }) {
  // 마운트 시 1회만 읽는 지연 초기화(useState 팩토리) — App이 매 키입력마다 리렌더되는데(0.9.1
  // detectGit 실사용자 보고와 동일 함정) 렌더 본문에서 직접 loadRepos()를 호출하면 타이핑마다
  // 동기 파일 I/O가 재발한다. 갱신은 아래 폴링 useEffect가 전담.
  const [repos, setRepos] = useState(() => loadRepos());
  useEffect(() => {
    const id = setInterval(() => setRepos(loadRepos()), REPOS_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  return (
    // flexShrink=0 필수(2026-07-17 tmux 80열 실측) — ink Box 기본 flexShrink=1이라 우측 컬럼
    // 콘텐츠가 넓으면 이 "고정폭" 36이 27로 쪼그라들어, 36 기준으로 예산 계산한
    // formatSidebarRepoPath 축약이 무력화되고 사이드바 내부 줄바꿈이 재발한다.
    <Box
      flexDirection="column"
      width={SIDEBAR_COLUMNS}
      flexShrink={0}
      borderStyle="round"
      borderColor="green"
      paddingX={1}
    >
      <Text color="green" bold>
        📁 repos <Text color="gray">— ⌃1..9 전환/opt-in · ⌃W opt-out</Text>
      </Text>
      {repos.length === 0 ? (
        <Text color="gray">등록된 repo 없음 — 'gbc repos add'로 추가</Text>
      ) : (
        repos.slice(0, 9).map((r, i) => {
          const tab = tabs.tabs[r];
          const isActive = r === tabs.activeTabId;
          const glyph = tab ? formatTabStatusGlyph(tab.status) : null;
          return (
            <Text key={r} color={isActive ? "green" : undefined}>
              {isActive ? "❯ " : "  "}
              <Text color="gray">⌃{i + 1} </Text>
              {glyph ? <Text color={toneColor(glyph.tone)}>{glyph.icon} </Text> : <Text color="gray">· </Text>}
              {formatSidebarRepoPath(r, r === cwd)}
              {r === cwd ? <Text color="gray"> (시작)</Text> : null}
            </Text>
          );
        })
      )}
      <Box flexGrow={1} />
      <Mascot lines={SIDEBAR_MASCOT_LINES} />
    </Box>
  );
}
