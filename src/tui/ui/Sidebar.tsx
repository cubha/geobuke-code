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
import React from "react";
import { Box, Text } from "ink";
import {
  MASCOT_S2,
  renderMascot,
  formatTabStatusGlyph,
  formatSidebarRepoPath,
  computeSidebarWindow,
  SIDEBAR_COLUMNS,
  SIDEBAR_HEADER_LABEL,
  SIDEBAR_HEADER_HINT,
  SIDEBAR_MAX_VISIBLE_REPOS,
} from "../format.js";
import { toneColor, BORDER_COLOR, PANEL_TITLE_COLOR } from "./theme.js";
import { Mascot } from "./Mascot.js";
import type { TabRegistry } from "../tabs.js";

// 0.10.1 — selectMascot(SIDEBAR_COLUMNS)는 스플래시 히어로용 함수(60열 미만이면 항상 C4 미니를
// 고름)라 SIDEBAR_COLUMNS(34 < 60)를 넣으면 항상 미니가 뜨는 결함이었다(사이드바는 스플래시 폭
// 규칙과 무관 — 내부폭 30에 S2(30폭)가 그대로 들어간다). MASCOT_S2를 직접 지정. SIDEBAR_COLUMNS는
// 상수라 이 값은 절대 안 바뀐다 — 모듈 로드 시 1회만 계산해 컴포넌트가 리렌더될 때마다(=매
// 키입력마다, App이 상태를 dispatch하므로) 다시 계산하지 않는다.
const SIDEBAR_MASCOT_LINES = renderMascot(MASCOT_S2);

export function Sidebar({
  cwd,
  tabs,
  repos,
  focused = false,
  cursor = 0,
  showMascot = true,
}: {
  cwd: string;
  tabs: TabRegistry;
  /** 0.10.6 A2 — repos.json 폴링(5초 간격)을 app.tsx로 끌어올렸다. 이전엔 이 컴포넌트가 자체
   * useState+useEffect로 들고 있었는데, computeResponsiveLayout(강등 판정)도 정확한 repo 개수가
   * 필요해져 단일 소스로 상위 이동했다 — I/O 총량은 그대로(폴링 지점이 1곳에서 다른 1곳으로
   * 옮겨졌을 뿐), 렌더마다 다시 읽지 않는다는 불변식은 유지된다. */
  repos: string[];
  /** Tab 포커스 중이면 커서 행을 강조하고 창이 커서를 따라간다(SubTask5). */
  focused?: boolean;
  cursor?: number;
  /** 저높이 반응형 강등 1단(0.10.6 A2) — false면 마스코트를 그리지 않는다. 마스코트 30×16
   * 픽셀 자체는 불변(사용자 확정 디자인) — 숨김/표시만 여기서 제어한다. */
  showMascot?: boolean;
}) {
  const win = computeSidebarWindow(repos.length, cursor, SIDEBAR_MAX_VISIBLE_REPOS);
  const visible = repos.slice(win.start, win.end);

  return (
    // flexShrink=0 필수(2026-07-17 tmux 80열 실측) — ink Box 기본 flexShrink=1이라 우측 컬럼
    // 콘텐츠가 넓으면 이 "고정폭" 36이 27로 쪼그라들어, 36 기준으로 예산 계산한
    // formatSidebarRepoPath 축약이 무력화되고 사이드바 내부 줄바꿈이 재발한다.
    // flexGrow=1(0.11.0) — 부모 leftStack 컬럼이 이제 정적 height(app.tsx chatTotalRows)를 갖는다.
    // Sidebar가 그 잔여 세로공간을 전부 차지해야 하단의 flexGrow 스페이서(마스코트 앞)가 실제로
    // 뭔가를 흡수할 공간이 생긴다 — flexGrow 없으면 Sidebar 자체가 콘텐츠 자연높이로 쪼그라들어
    // 스페이서가 무력화된다.
    <Box
      flexDirection="column"
      width={SIDEBAR_COLUMNS}
      flexShrink={0}
      flexGrow={1}
      borderStyle="round"
      borderColor={focused ? toneColor("accent") : BORDER_COLOR}
      paddingX={1}
    >
      {/* 0.10.3 — Alt+ 표기로 교체(레거시 터미널은 Ctrl+숫자 미전송, 이슈③). 텍스트는 format.ts
          SIDEBAR_HEADER_LABEL/HINT(단일 소스) — SIDEBAR_CHROME_ROWS 측정 텍스트와 항상 같아야
          줄바꿈 행수 드리프트가 재발하지 않는다(0.10.6 A2 tmux 실측 결함 근본수정). */}
      <Text color={PANEL_TITLE_COLOR} bold>
        {SIDEBAR_HEADER_LABEL} <Text color="gray">{SIDEBAR_HEADER_HINT}</Text>
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
            // 0.10.4 ST3 — cyan 폐기: 커서·활성 둘 다 accent(green)로 통일(theme.ts 원칙 준수).
            // 시각 구분은 prefix(▸ 커서 vs ❯ 활성)가 이미 맡고 있어 색상 통일로 정보 손실 없음.
            const rowColor = isCursor || isActive ? toneColor("accent") : undefined;
            return (
              <Text key={r} color={rowColor}>
                {prefix}
                {/* 숫자만 표시(폭 3 유지) — 수식키는 헤더의 "Alt+1..9"가 안내한다(구 ⌃N 표기는
                    레거시 터미널에서 동작하지 않는 거짓 안내였다, 0.10.3 이슈③). */}
                <Text color="gray">{i < 9 ? ` ${i + 1} ` : "   "}</Text>
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
      {showMascot && <Mascot lines={SIDEBAR_MASCOT_LINES} />}
    </Box>
  );
}
