// 0.10.0 A3b ST10/ST11 — 터틀 덱 좌측 상시 사이드바(고정폭). 기존 ReposPanel(⌃R 토글 오버레이, 게이트
// 설치 여부 표시)과는 구조적으로 분리된 신규 컴포넌트다 — 토글 패널 시스템(model.ts Panel 타입)을
// 건드리지 않고 항상 보이는 별도 레이아웃 축으로 추가해 기존 ⌃M/⌃R/⌃S 동작에 회귀가 없다.
// ST11: opt-in 탭(tabs.ts TabRegistry)의 세션 상태를 formatTabStatusGlyph(ST9 어휘)로 표시하고,
// 등록됐지만 아직 opt-in 안 된 repo는 Ctrl+N 힌트만 보여준다.
// 0.10.1 SubTask5 — 키보드 내비게이션(focused/cursor). computeSidebarWindow(SubTask4)로 10개
// 이상일 때 침묵 잘림을 해소한다. ⌃1..9 직행 단축키는 app.tsx에서 항상 repos[0..8]로 고정
// 배선돼 있어(포커스·스크롤 상태와 무관) 창이 스크롤돼 9번째 이후가 보이는 항목엔 애초에 ⌃N
// 단축키가 존재하지 않는다 — 그 항목엔 라벨을 비워 "이 항목은 ⌃N으로 못 간다"를 시각적으로
// 정확히 반영한다(전역 인덱스<9일 때만 ⌃{i+1} 표시).
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { loadRepos } from "../../repos.js";
import { MASCOT_S2, renderMascot, formatTabStatusGlyph, formatSidebarRepoPath, computeSidebarWindow, SIDEBAR_COLUMNS } from "../format.js";
import { toneColor } from "./theme.js";
import { Mascot } from "./Mascot.js";
import type { TabRegistry } from "../tabs.js";

// 0.10.1 — selectMascot(SIDEBAR_COLUMNS)는 스플래시 히어로용 함수(60열 미만이면 항상 C4 미니를
// 고름)라 SIDEBAR_COLUMNS(34 < 60)를 넣으면 항상 미니가 뜨는 결함이었다(사이드바는 스플래시 폭
// 규칙과 무관 — 내부폭 30에 S2(30폭)가 그대로 들어간다). MASCOT_S2를 직접 지정. SIDEBAR_COLUMNS는
// 상수라 이 값은 절대 안 바뀐다 — 모듈 로드 시 1회만 계산해 컴포넌트가 리렌더될 때마다(=매
// 키입력마다, App이 상태를 dispatch하므로) 다시 계산하지 않는다.
const SIDEBAR_MASCOT_LINES = renderMascot(MASCOT_S2);

// repos.json은 'gbc repos add/remove' CLI로만 바뀌는 드문 이벤트라 실시간 반응이 필요 없다 —
// 주기적 폴링으로 충분(과함).
const REPOS_REFRESH_MS = 5000;

// 사이드바 내부 가용폭(SIDEBAR_COLUMNS-테두리2-paddingX2=30) 안에서 한 번에 보여줄 repo 수 —
// ⌃1..9 직행 단축키가 물리적으로 9개뿐이라 이 값과 별개로 고정.
const SIDEBAR_MAX_VISIBLE = 9;

export function Sidebar({
  cwd,
  tabs,
  focused = false,
  cursor = 0,
}: {
  cwd: string;
  tabs: TabRegistry;
  /** Tab 포커스 중이면 커서 행을 강조하고 창이 커서를 따라간다(SubTask5). */
  focused?: boolean;
  cursor?: number;
}) {
  // 마운트 시 1회만 읽는 지연 초기화(useState 팩토리) — App이 매 키입력마다 리렌더되는데(0.9.1
  // detectGit 실사용자 보고와 동일 함정) 렌더 본문에서 직접 loadRepos()를 호출하면 타이핑마다
  // 동기 파일 I/O가 재발한다. 갱신은 아래 폴링 useEffect가 전담.
  const [repos, setRepos] = useState(() => loadRepos());
  useEffect(() => {
    const id = setInterval(() => setRepos(loadRepos()), REPOS_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const win = computeSidebarWindow(repos.length, cursor, SIDEBAR_MAX_VISIBLE);
  const visible = repos.slice(win.start, win.end);

  return (
    // flexShrink=0 필수(2026-07-17 tmux 80열 실측) — ink Box 기본 flexShrink=1이라 우측 컬럼
    // 콘텐츠가 넓으면 이 "고정폭" 36이 27로 쪼그라들어, 36 기준으로 예산 계산한
    // formatSidebarRepoPath 축약이 무력화되고 사이드바 내부 줄바꿈이 재발한다.
    <Box
      flexDirection="column"
      width={SIDEBAR_COLUMNS}
      flexShrink={0}
      borderStyle="round"
      borderColor={focused ? "cyan" : "green"}
      paddingX={1}
    >
      <Text color="green" bold>
        📁 repos <Text color="gray">— ⌃1..9 전환/opt-in · ⌃W opt-out</Text>
      </Text>
      {repos.length === 0 ? (
        <Text color="gray">등록된 repo 없음 — 'gbc repos add'로 추가</Text>
      ) : (
        <>
          {win.aboveCount > 0 && <Text color="gray">▲ 위 {win.aboveCount}개</Text>}
          {visible.map((r, localIdx) => {
            // 전역 인덱스 — ⌃N 라벨·cursor 비교 전부 이 값 기준이어야 한다(윈도잉 이후 로컬
            // 인덱스를 쓰면 ⌃N이 다른 repo를 가리키는 결함이 된다, 0.2.5 전례 재발 방지).
            const i = win.start + localIdx;
            const tab = tabs.tabs[r];
            const isActive = r === tabs.activeTabId;
            const isCursor = focused && i === cursor;
            const glyph = tab ? formatTabStatusGlyph(tab.status) : null;
            const prefix = isCursor ? "▸ " : isActive ? "❯ " : "  ";
            const rowColor = isCursor ? "cyan" : isActive ? "green" : undefined;
            return (
              <Text key={r} color={rowColor}>
                {prefix}
                <Text color="gray">{i < 9 ? `⌃${i + 1} ` : "   "}</Text>
                {glyph ? <Text color={toneColor(glyph.tone)}>{glyph.icon} </Text> : <Text color="gray">· </Text>}
                {formatSidebarRepoPath(r, r === cwd)}
                {r === cwd ? <Text color="gray"> (시작)</Text> : null}
              </Text>
            );
          })}
          {win.belowCount > 0 && <Text color="gray">▼ 아래 {win.belowCount}개</Text>}
        </>
      )}
      <Box flexGrow={1} />
      <Mascot lines={SIDEBAR_MASCOT_LINES} />
    </Box>
  );
}
