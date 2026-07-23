// 0.9.0 A3a ST5 — gbc TUI 메인 화면(시안 A: 토글 패널형). ink/react를 이 파일이 직접 정적 import
// 한다 — 격리 경계는 cli.ts→app.tsx의 lazy dynamic import 쪽(ST6)에 있다(ST0 회귀락 대상은 cli.ts).
// 이 파일은 얇은 오케스트레이션+렌더만 한다 — 상태전이는 model.ts/editor.ts, 표시문구는 format.ts,
// 엔진↔TUI 변환은 bridge.ts가 전담(순수, TDD 커버). 여기서 새 판정 로직을 만들지 않는다.
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useCursor, useInput, useWindowSize, type Key } from "ink";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { GateDecision } from "../gate-core.js";
import { createInitialState, reduce, type TuiState, type ApprovalChoice } from "./model.js";
import * as Editor from "./editor.js";
import type { EditorState } from "./editor.js";
import {
  formatGateLine,
  formatStatusline,
  formatSpinnerLine,
  formatMarkdownLite,
  computeContentColumns,
  computePreviewRowBudget,
  computeFrameLayout,
  computeChatRegionRows,
  computeHeaderRows,
  wrapSegmentLine,
  tailLines,
  computeInputLayout,
  computeSidebarWindow,
  INPUT_PROMPT_PREFIX,
  SIDEBAR_COLUMNS,
  PREVIEW_RESERVED_ROWS,
  CHAT_SCROLLBACK_MAX_ENTRIES,
  type CardSkill,
  type TextSegment,
  type Tone,
} from "./format.js";
import {
  mapEngineMessageToTuiEvents,
  buildGateResultEvent,
  classifyApprovalRequest,
  resolveApproval,
  formatEngineFailure,
  formatEngineAbort,
  formatResumeFallbackBanner,
  formatCrashDump,
  formatSessionStartFailure,
  DeltaAssembler,
} from "./bridge.js";
import { createEngineSessionWithResumeFallback, buildSessionOptionsForRepo, mapSdkMessage, type EngineSession } from "../engine.js";
import { getLastSessionId, setLastSessionId } from "../session-map.js";
import { makeSdkPreToolUseHook } from "../gate-sdk.js";
import { readSpecCases } from "../spec.js";
import { activeDeferItems, addDefer } from "../defer.js";
import { loadRepos } from "../repos.js";
import { createTabRegistry, ensureTab, removeTab, setActiveTab, updateTabStatus } from "./tabs.js";
import { appendText, appendSegments, getBuffer, type ScrollBuffers } from "./scrollback.js";
import { gbcDir } from "../store.js";
import { nowIso } from "../time.js";
import { Segments } from "./ui/Segments.js";
import { ApprovalBox } from "./ui/ApprovalBox.js";
import { MetricsPanel } from "./ui/MetricsPanel.js";
import { ReposPanel } from "./ui/ReposPanel.js";
import { SkillsPanel } from "./ui/SkillsPanel.js";
import { SplashHeader } from "./ui/SplashHeader.js";
import { WelcomeCard } from "./ui/WelcomeCard.js";
import { Sidebar } from "./ui/Sidebar.js";
import { Frame } from "./ui/Frame.js";
import { FRAME_COLOR, toneColor } from "./ui/theme.js";
import { ChatBox, type ChatEntry } from "./ui/ChatBox.js";
import { SlashDropdown } from "./ui/SlashDropdown.js";
import { HelpPanel } from "./ui/HelpPanel.js";
import { scanSkills, scanSkillsWithOrigin, loadSkillBody } from "./skills.js";
import { computeSlashQuery, filterSkills, completeSlashText, composeSkillPrompt } from "./slash.js";
import { GBC_SKILL_NAMES } from "../install.js";

// 구 SplashHero.tsx의 여백 사양 그대로 유지(SubTask10 — 전체폭 헤더로 위치가 바뀌어도 좌측
// 여백 값 자체는 승인 시안과 동일하게 보존). 0.11.0 — 상단 여백(구 HERO_TOP_MARGIN)은 헤더 압축
// (10→7/1행)으로 제거됐다(SplashHeader.tsx 주석 참조).
const HERO_LEFT_MARGIN = 3;

// 0.10.1 SubTask2 — 대화창 박스(ChatBox) 행 예산 산정 상수. computeChatRegionRows(순수, format.ts)가
// 준 전체 예산에서 이 고정분을 빼면 메시지 뷰포트 행수(viewportRows)가 나온다.
// ⓐ 헤더 행수 — 0.11.0부터 computeHeaderRows(format.ts)가 단일 소스(타이틀이 상시 렌더되며
// full/mini 두 모드를 가지므로 상수가 아니라 함수). 구 CHAT_HEADER_ROWS_WIDE/NARROW(스플래시
// 소멸 전제·측정 상수)는 폐기.
// ⓑ ChatBox 자체 테두리(상하 각 1) + 스크롤 인디케이터(항상 1행 예약).
const CHAT_BOX_CHROME_ROWS = 3;
// ⓒ 하단 고정 UI 중 입력창을 뺀 고정분 — 입력창 테두리(상하 2) + 게이트줄(1) + statusline(1).
// 입력창 내용 행수는 0.10.3부터 에디터 실제 텍스트를 랩해 동적으로 계산한다(멀티라인/랩 성장분을
// 뷰포트 예산에서 차감하지 않으면 박스가 예산을 초과해 프레임 전체가 밀린다 — 2026-07-22 현장
// 이슈②의 한 갈래). 승인 중엔 ApprovalBox가 입력창 자리를 대신하며 대체로 비슷한 최소 행수를
// 쓴다(reason 길이에 따라 늘 수 있는 알려진 한계 — ChatBox 외곽 overflow hidden이 최종 방어).
const CHAT_BOTTOM_CHROME_ROWS = 2 + 1 + 1;
// 좌측 스택(카드+사이드바)과 ChatBox 사이 시각적 여백 — 시안(ff0eb0b1) `.cols{gap:10px}` 대응.
const CHAT_COLUMN_GAP = 1;
// PgUp/PgDn 1회당 스크롤 시각행 수 — 정확히 한 페이지일 필요는 없다(computeChatViewport가
// 과대 offset을 항상 클램프하므로 의미 있게 스크롤되기만 하면 된다).
const PGSCROLL_STEP = 10;

// 0.9.3 D2 — 스플래시 카드용 짧은 blurb(⌃S 패널의 SkillInfo.description 전문과는 별개 — 54칸
// 카드 폭엔 전문이 안 맞아 큐레이션 필요). 이름이 이 표에 없으면 실제 description을 짧게 잘라
// fallback한다(향후 gbc 자체 스킬이 늘어도 조용히 blurb 없는 항목이 되지 않게).
// 0.10.1 — 카드 폭 54→34 통일(내부 30열 예산)로 재큐레이션. 카피 무손실, 축약만(원문은 ⌃S skills
// 패널의 SkillInfo.description에 그대로 남아있음).
const SPLASH_SKILL_BLURBS: Record<string, string> = {
  gate: "spec·verify 관리",
  "gbc-monitor": "현황 조회",
  "gbc-mute": "리마인드 on/off",
};

/** 스플래시 카드에 표시할 gbc 자체 스킬만(GBC_SKILL_NAMES 순서) — 실제 설치 확인은 scanSkills로. */
function resolveCardSkills(cwd: string): CardSkill[] {
  const installed = new Map(scanSkills(cwd).map((s) => [s.name, s]));
  const out: CardSkill[] = [];
  for (const name of GBC_SKILL_NAMES) {
    const found = installed.get(name);
    if (!found) continue; // 미설치(gbc init 안 함) — 조용히 생략
    // 폴백 슬라이스 40→12: 0.10.1 카드 내부폭 30 예산(이름 최장 "/gbc-monitor"=12+구분자3=15,
    // 남는 15 표시폭 안에서 한글 혼입 시에도 넘치지 않도록 보수적으로 12자로 축소.
    // GBC_SKILL_NAMES(gate/gbc-mute/gbc-monitor) 전부 위 SPLASH_SKILL_BLURBS에 있어 현재는 미도달.
    out.push({ name, blurb: SPLASH_SKILL_BLURBS[name] ?? found.description.slice(0, 12) });
  }
  return out;
}

// ScrollEntry(text/segments 두 kind)는 0.10.4 ST2부터 src/tui/scrollback.ts가 소유한다 — repoId로
// 격리된 버퍼(ScrollBuffers)로 전환하며 이 앱 파일에 로컬로 두던 타입을 그 순수 모듈로 이전했다
// (결함1: repo 전환 시 대화 소실 근본수정, scrollback.ts 모듈 주석 참조).

function detectGit(cwd: string): { branch: string; dirty: boolean } {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const status = execSync("git status --porcelain", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return { branch, dirty: status.trim().length > 0 };
  } catch {
    return { branch: "", dirty: false }; // git 리포 아님 — 정상 케이스, statusline은 빈 branch로 표시
  }
}

function applyEditorKey(input: string, key: Key, s: EditorState): EditorState {
  if (key.leftArrow) return Editor.moveCursorLeft(s);
  if (key.rightArrow) return Editor.moveCursorRight(s);
  if (key.upArrow) return Editor.arrowUp(s);
  if (key.downArrow) return Editor.arrowDown(s);
  if (key.backspace || key.delete) return Editor.backspace(s);
  if (input && !key.ctrl && !key.meta) return Editor.insertText(s, input);
  return s;
}

export function App({ cwd, model, version }: { cwd: string; model?: string; version: string }) {
  const { columns, rows } = useWindowSize();
  // 0.10.1 — 외부 '+' 프레임(braintrust 확정)이 활성이면 좌우 거터가 콘텐츠 가용폭을 잠식한다.
  // 히어로/repos 패널의 columns 산정과 스트리밍 프리뷰 행 예산 모두 이 innerColumns/bandRows를
  // 거쳐야 프레임 두께만큼 겹치거나 잘리지 않는다(computeFrameLayout은 순수 판정, 실제 렌더는
  // <Frame>이 전담).
  const frameLayout = computeFrameLayout(columns, rows);
  const [state, dispatch] = useReducer(reduce, undefined, () => {
    // detectGit은 execSync 2회(git rev-parse·git status)라 lazy initializer 안에서만 불러 마운트
    // 시점 1회로 제한한다 — 컴포넌트 본문 최상단에 두면 매 리렌더(=매 키입력)마다 재실행돼 타이핑이
    // 밀린다(0.9.1 실사용자 보고). 유일한 소비 지점이 이 시드값이라 이동만으로 완결된다.
    const git = detectGit(cwd);
    return {
      ...createInitialState({ dir: cwd, branch: git.branch, dirty: git.dirty, model: model ?? "" }),
      // createInitialState는 spec/defer 카운트를 모르는 순수함수라 0으로 시작한다 — 마운트 시점에
      // 실제 값으로 시드해야 스플래시 문구("spec 8케이스")와 게이트 줄("spec 0케이스")이 어긋나지
      // 않는다(스모크 테스트로 발견·수정).
      specCount: readSpecCases(cwd).length,
      deferCount: activeDeferItems(cwd).length,
    };
  });
  const stateRef = useRef<TuiState>(state);
  stateRef.current = state;

  const [editorState, setEditorState] = useState<EditorState>(() => Editor.createInitialState());
  const [approvalEditing, setApprovalEditing] = useState(false);
  const [approvalEditor, setApprovalEditor] = useState<EditorState>(() => Editor.createInitialState());
  // ST11 — opt-out y/n 확인 대기 중인 repoId(armed 아니면 null). 승인(state.approval)과는 별개
  // 채널이라 두 확인이 동시에 뜨지 않게 opt-out 시작은 !state.approval일 때만 허용한다.
  const [optOutConfirmRepoId, setOptOutConfirmRepoId] = useState<string | null>(null);

  // SubTask5(0.10.1) — 사이드바 repos 키보드 내비게이션. Tab으로 토글, 포커스 중엔 ↑/↓가 에디터가
  // 아니라 이 커서를 움직인다(useInput 하단 배선). activateApproval이 승인 도착 시 자동 해제한다.
  const [sidebarFocused, setSidebarFocused] = useState(false);
  const [sidebarCursor, setSidebarCursor] = useState(0);
  // 0.10.4 ST6(개선2) — Alt+R repos 패널 키보드 커서(전역 인덱스, Sidebar와 동일 관례).
  const [reposPanelCursor, setReposPanelCursor] = useState(0);

  // 0.10.4 ST2(결함1 근본수정) — 단일 배열 대신 repoId로 격리된 버퍼(scrollback.ts). 비활성 탭에
  // append해도 다른 탭 버퍼를 건드리지 않으므로, repo 전환 시 화면 이력이 사라지지 않고 백그라운드
  // 탭에 도착한 메시지도 유실 없이 보존된다(구 setScrollback([...전환 안내 1줄]) 전면 리셋 폐기).
  const [scrollBuffers, setScrollBuffers] = useState<ScrollBuffers>({});
  const nextId = useRef(0);
  // SubTask2(대화창 박스) — Static 폐기로 스크롤백이 이제 실제로 화면에 매 프레임 다시 그려지므로
  // 상한이 없으면 장시간 세션에서 랩 비용(wrapSegmentLine)이 무한정 커진다. SubTask3 — PgUp/PgDn이
  // 이 값을 조절(useInput 하단), 새 제출·탭 전환 시 0(최하단)으로 강제 복귀.
  const [scrollOffset, setScrollOffset] = useState(0);

  // SubTask10 — 안내카드의 스킬 목록(skills.ts scanSkills 파일 I/O)만 마운트 시 1회 지연 계산한다.
  // spec/defer 카운트는 이미 state.specCount/deferCount(위 lazy initializer가 시드)가 있어 별도
  // 계산이 불필요. 0.11.0 — 카드는 이제 고정 레이아웃으로 상시 표시된다(구 splashDismissed 조건부
  // 소멸 폐기, 스트리밍 중에도 GATE_RESULT로 카운트만 갱신되며 카드 자체는 계속 보인다).
  const [cardSkills] = useState(() => resolveCardSkills(cwd));

  // 0.10.4 ST5(개선1) — 슬래시 드롭다운용 전체 스킬 목록(프로젝트+전역). cardSkills와 동일하게
  // 마운트 시 1회 지연 계산(SKILL.md 파일 I/O를 매 렌더·매 키입력마다 반복하지 않는다).
  const [slashSkills] = useState(() => scanSkillsWithOrigin(cwd));
  const [slashCursor, setSlashCursor] = useState(0);
  // Esc로 드롭다운을 닫으면 그 시점의 첫 줄 텍스트를 기억해두고, 텍스트가 바뀌기 전까진 다시 열지
  // 않는다(별도 open 플래그 없이 파생 상태로만 열림/닫힘을 표현 — 에디터·드롭다운 상태 desync 차단).
  const [slashSuppressedFor, setSlashSuppressedFor] = useState<string | null>(null);

  // ST11(0.10.0 A3b) — 탭 레지스트리(tabs.ts, ST1). cwd(App 시작 repo)가 항상 첫 탭 — tabs.ts
  // "최소 1탭 유지" 불변식과 대칭. activeTabId가 바뀌면 TuiState 전체를 TAB_SWITCHED로 재시드한다
  // (model.ts 주석 참조 — 다른 세션의 진행 상태를 이어받으면 그 자체가 교차오염 표면이 된다).
  const [tabs, setTabs] = useState(() => createTabRegistry(cwd));
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // ST1(0.9.4 T1)→ST11(0.10.0 A3b): 세션 프로세스 재사용이 이제 repoId별로 여러 개 살아있을 수
  // 있다(opt-in 탭 = in-flight 탭만 상주). Map으로 전환 — buildSessionOptionsForRepo(ST2)가 cwd를
  // 항상 repoId로 강제하므로 이 Map의 키와 각 세션의 실제 cwd가 어긋날 수 없다(원자 결박).
  const sessionsRef = useRef(new Map<string, EngineSession>());
  // ST3(0.9.4 T2)→ST11: partial 델타 어셈블러도 repoId별. index별 누적 안전성 근거는 기존과 동일
  // (bridge.ts DeltaAssembler 주석) — 탭마다 독립된 인스턴스라 교차오염 자체가 물리적으로 불가능.
  const deltaAssemblersRef = useRef(new Map<string, DeltaAssembler>());
  function getDeltaAssembler(repoId: string): DeltaAssembler {
    let d = deltaAssemblersRef.current.get(repoId);
    if (!d) {
      d = new DeltaAssembler();
      deltaAssemblersRef.current.set(repoId, d);
    }
    return d;
  }
  // ST5→ST11: STREAM_DELTA dispatch 스로틀도 repoId별(ink 30fps 락 위반 방지, scope-critic ST3 지적
  // 반영은 유지). 백그라운드 탭의 델타는 스로틀만 하고 dispatch는 하지 않는다 — 지금 화면에 안 보이는
  // 텍스트를 굳이 렌더 큐에 밀어넣지 않는다(활성 탭 전환 시점의 repoId 비교로 판단).
  const streamThrottlesRef = useRef(new Map<string, { timer: NodeJS.Timeout | null; lastAt: number }>());
  const STREAM_THROTTLE_MS = 80;
  const scheduleStreamDelta = useCallback((repoId: string, text: string) => {
    let t = streamThrottlesRef.current.get(repoId);
    if (!t) {
      t = { timer: null, lastAt: 0 };
      streamThrottlesRef.current.set(repoId, t);
    }
    const tt = t;
    if (tt.timer) clearTimeout(tt.timer);
    const elapsed = Date.now() - tt.lastAt;
    const flush = () => {
      tt.lastAt = Date.now();
      tt.timer = null;
      if (repoId === tabsRef.current.activeTabId) dispatch({ type: "STREAM_DELTA", text });
    };
    if (elapsed >= STREAM_THROTTLE_MS) flush();
    else tt.timer = setTimeout(flush, STREAM_THROTTLE_MS - elapsed);
  }, []);
  const commitStream = useCallback((repoId: string) => {
    const t = streamThrottlesRef.current.get(repoId);
    if (t?.timer) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    if (repoId === tabsRef.current.activeTabId) dispatch({ type: "STREAM_COMMIT" });
  }, []);
  // ST10(0.9.2) — Ctrl+C 2단 확인종료 타이머(armed 상태를 일정 시간 뒤 자동 해제). model.ts는
  // armed 여부만 순수 추적하고(ST9), "일정 시간"이라는 impure 타이밍 판단은 여기서 맡는다.
  const exitConfirmTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ST8(0.9.2) — 스트리밍 중 로딩 스피너. tick·elapsedMs는 여기서 setInterval로 계산해 순수
  // 포맷터(formatSpinnerLine)에 넘긴다(format.ts는 Date.now()를 직접 쓰지 않는다).
  const [spinnerTick, setSpinnerTick] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!state.streaming) return;
    const start = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => {
      setSpinnerTick((t) => t + 1);
      setElapsedMs(Date.now() - start);
    }, 120);
    return () => clearInterval(id);
  }, [state.streaming]);
  // repoId 필수 인자화(0.10.4 ST2) — 어느 탭의 버퍼에 쌓을지 호출부가 항상 명시한다. CHAT_SCROLLBACK_
  // MAX_ENTRIES(SubTask1, 무한증식 방지)는 scrollback.ts appendText가 repo별 독립 적용한다.
  const pushLine = useCallback((repoId: string, text: string, tone: Tone = "plain") => {
    setScrollBuffers((buffers) => appendText(buffers, repoId, nextId.current++, text, tone, CHAT_SCROLLBACK_MAX_ENTRIES));
  }, []);

  // 0.10.4 ST3 — 사용자 메시지 에코 전용(다중 톤 세그먼트). "❯ "만 accent, 본문은 plain — 예전엔
  // 통째로 tone:"code"(cyan)라 표준 팔레트("녹색은 마커에만", theme.ts 원칙) 이탈이었다.
  const pushSegments = useCallback((repoId: string, segments: TextSegment[]) => {
    setScrollBuffers((buffers) => appendSegments(buffers, repoId, nextId.current++, segments, CHAT_SCROLLBACK_MAX_ENTRIES));
  }, []);

  // ST12(0.10.0 A3b) — 크래시 덤프 4경로. 알트스크린(ST10)은 teardown 프레임을 보존하지 않는다
  // (ink 공식 동작) — 종료 사유 불문 화면이 그냥 사라지므로, 마지막으로 보이던 scrollback을 파일로
  // 남겨야 복구 가능하다. scrollbackRef는 stateRef/tabsRef와 동일한 "항상 최신값" 미러 패턴.
  const scrollBuffersRef = useRef(scrollBuffers);
  scrollBuffersRef.current = scrollBuffers;
  useEffect(() => {
    // 4경로 중 하나라도 먼저 dump를 쓰면 그 이후는 덮어쓰지 않는다 — uncaughtException→process.exit(1)이
    // 다시 'exit' 이벤트를 발화시키는 것처럼 한 종료가 여러 이벤트를 연쇄시킬 수 있어, 가장 구체적인
    // 첫 사유를 보존한다(마지막 'exit'의 뭉뚱그려진 사유로 덮이면 디버깅 정보가 준다).
    let dumped = false;
    const dump = (reason: string) => {
      if (dumped) return;
      dumped = true;
      try {
        // scope-critic 지적 — 크래시 시점에 보이던 scrollback은 "지금 활성 탭"의 것이므로, App
        // 시작 repo(cwd, 불변)가 아니라 그 탭의 repo에 저장해야 실제로 크래시가 난 repo에 남는다.
        const text = formatCrashDump(
          getBuffer(scrollBuffersRef.current, tabsRef.current.activeTabId),
          reason,
          nowIso(),
        );
        writeFileSync(join(gbcDir(tabsRef.current.activeTabId), "crash-dump.txt"), text, "utf8");
      } catch {
        // 크래시 와중의 부가 기능 — 실패해도 원래 종료·에러 흐름을 절대 막지 않는다.
      }
    };
    const onExit = () => dump("exit");
    const onSigint = () => {
      dump("SIGINT");
      process.exit(130);
    };
    const onSigterm = () => {
      dump("SIGTERM");
      process.exit(143);
    };
    const onUncaught = (err: unknown) => {
      dump(`uncaughtException: ${String(err).slice(0, 200)}`);
      process.exit(1);
    };
    process.on("exit", onExit);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("uncaughtException", onUncaught);
    // cleanup 없음(의도) — scope-critic 지적대로 4경로 전부 process.exit()로 즉시 종료되므로 React
    // unmount cleanup이 실행될 기회가 없다(TUI는 정상 실행 중 언마운트되지 않는다). 리스너 등록은
    // 프로세스 생명주기 전체에 1회면 충분 — off() 코드는 절대 안 불릴 죽은 코드였다.
  }, []);

  // 단일 ref가 아닌 큐 — SDK가 한 턴 안에서 서로 다른 tool_use 2개(예: gated Edit + Bash spec-add)에
  // canUseTool을 겹쳐 호출할 가능성을 코드로 배제할 수 없다(2026-07-10 자체검토로 발견). 단일 ref였다면
  // 두 번째 호출이 첫 번째의 resolver를 덮어써 첫 approval Promise가 영구 대기(leak)했다 — 큐로 직렬화해
  // 화면엔 한 번에 하나만 뜨되 응답 즉시 다음 것을 이어서 연다.
  // repoId(0.10.0 A3b ST3) — 이 approval이 어느 repo의 세션에서 발생했는지 큐 아이템에 직접
  // 태깅한다. 큐가 여러 세션(탭)의 canUseTool을 공유하게 될 때(ST10/11 다중탭 배선), "지금 화면에
  // 뜬 승인이 정확히 어느 repo 것인가"와 "부수효과(defer)를 어느 repo에 커밋할까"를 App의 단일
  // cwd 클로저가 아니라 이 필드로 판단해야 한다 — LLM 재유입 경로 1(승인 부수효과 cwd 오라우팅) 차단.
  type QueuedApproval = {
    ctx: ReturnType<typeof classifyApprovalRequest>;
    reason: string;
    repoId: string;
    resolve: (a: { choice: ApprovalChoice; editedText?: string }) => void;
  };
  const approvalQueue = useRef<QueuedApproval[]>([]);
  const activateApproval = useCallback((item: QueuedApproval) => {
    dispatch({ type: "APPROVAL_REQUESTED", reason: item.reason, kind: item.ctx.kind });
    if (item.ctx.kind === "spec-add") {
      dispatch({ type: "APPROVAL_CASE_DERIVED", caseText: item.ctx.derivedCase });
    }
    setSidebarFocused(false); // SubTask5 — 승인 프롬프트가 뜨면 사이드바 포커스를 자동 해제.
  }, []);

  // SubTask10 — 스플래시(워드마크+카드+웰컴)는 더 이상 Static에 커밋하지 않는다. 0.11.0부터는
  // splashDismissed 조건부 소멸 자체가 폐기되고 타이틀(SplashHeader)·카드가 항상 렌더된다 —
  // state.titleMode(full/mini)만 ⌃T로 바뀌며, 웰컴 라인은 여전히 첫 턴 전에만 보인다(showWelcome).

  // repoId(0.10.0 A3b ST3): 이 canUseTool 인스턴스가 어느 repo의 세션에 배선됐는지. getOrCreateSession이
  // 세션 생성 시점에 그 세션의 repoId를 넘긴다 — 지금은 단일 세션(App의 cwd)뿐이라 항상 cwd와 같지만,
  // ST10/11에서 repoId별 세션 Map이 들어와도 이 함수 시그니처를 다시 바꿀 필요가 없다(seam 선반영).
  const makeInkCanUseTool = useCallback((repoId: string): CanUseTool => {
    return async (toolName, input, options) => {
      const ctx = classifyApprovalRequest(toolName, input as Record<string, unknown>);
      const answer = await new Promise<{ choice: ApprovalChoice; editedText?: string }>((resolve) => {
        const item: QueuedApproval = { ctx, reason: options.decisionReason ?? "", repoId, resolve };
        const wasEmpty = approvalQueue.current.length === 0;
        approvalQueue.current.push(item);
        // 큐가 비어있었을 때만 즉시 화면에 띄운다 — 이미 뭔가 대기 중이면 그게 응답될 때 이어서 연다.
        if (wasEmpty) activateApproval(item);
      });
      const resolution = resolveApproval(answer.choice, ctx, input as Record<string, unknown>, answer.editedText);
      // ANSWERED dispatch는 useInput의 answer() 헬퍼가 resolve() 직전에 이미 실행한다(3차 자체검토로
      // 발견한 중복 제거 — 여기서 다시 부르면 동일 이벤트가 두 번 발화돼 향후 reducer가 비-멱등 로직을
      // 갖게 될 때 이중 실행 버그의 씨앗이 된다).
      // resolvedItem — shift()가 반환하는 "지금 막 답변된 그 아이템"에서 repoId를 읽는다(큐 헤드가
      // 우연히 다른 repo 것일 리 없음: canUseTool 클로저마다 자기 repoId로 push했으므로 이 아이템은
      // 항상 이 canUseTool 호출이 만든 그 아이템이다 — 그래도 방어적으로 cwd를 최종 폴백에 둔다).
      const resolvedItem = approvalQueue.current.shift();
      if (resolution.deferText) {
        try {
          addDefer(resolvedItem?.repoId ?? cwd, resolution.deferText);
        } catch {
          // 로컬 TUI 편의기능 — 실패해도 canUseTool 응답(deny)은 이미 확정돼 있어 엔진 흐름은 계속됨.
        }
      }
      const next = approvalQueue.current[0];
      if (next) activateApproval(next);
      return resolution.result;
    };
  }, [cwd, activateApproval]);

  // ST11 — repoId별 게이트 판정 콜백. 백그라운드 탭의 판정은 TuiState(단일 라이브 뷰)에 절대
  // dispatch하지 않는다 — 화면엔 지금 보고 있는 탭의 게이트 상태만 떠야 한다(교차오염 표면 차단,
  // ST1 round1 critic이 지적한 "TuiState↔TabRegistry 동기화 계약"의 실제 구현 지점).
  const makeOnGateDecision = useCallback(
    (repoId: string) => (decision: GateDecision) => {
      if (repoId !== tabsRef.current.activeTabId) return;
      const specCount = readSpecCases(repoId).length;
      const deferCount = activeDeferItems(repoId).length;
      dispatch(buildGateResultEvent(decision, specCount, deferCount));
    },
    [],
  );

  // ST11 — repoId별 엔진 메시지 핸들러. 델타 어셈블·스트림 스로틀은 항상 그 탭 몫으로 누적하되
  // (백그라운드에서도 진행은 계속돼야 함), 화면 dispatch/pushLine은 activeTabId와 일치할 때만 —
  // 다른 탭의 진행 상황이 지금 보고 있는 대화창에 섞여 들어가면 안 된다.
  const makeHandleEngineMessage = useCallback(
    (repoId: string) =>
      (msg: Parameters<NonNullable<Parameters<typeof createEngineSessionWithResumeFallback>[0]["onMessage"]>>[0]) => {
        const accum = getDeltaAssembler(repoId).apply(
          msg as unknown as { type?: string; event?: { type?: string; index?: number; content_block?: { type?: string }; delta?: { type?: string; text?: string } } },
        );
        if (accum !== null) scheduleStreamDelta(repoId, accum);

        // 0.10.4 ST2(결함1 핵심 수정) — TuiState(단일 라이브 뷰) dispatch는 여전히 활성 탭에만
        // 국한한다(교차오염 차단, 기존 설계 유지). 그러나 scrollback append는 활성 여부와 무관하게
        // 항상 실행해야 한다 — 예전엔 여기서 그냥 return해 배경 탭에 도착한 메시지가 어디에도
        // 기록되지 않고 영구 유실됐다(사외 실사용 보고 근본원인).
        if (repoId === tabsRef.current.activeTabId) {
          for (const ev of mapEngineMessageToTuiEvents(msg)) dispatch(ev);
        }
        for (const rec of mapSdkMessage(msg)) {
          if (!rec.text) continue;
          if (rec.kind === "assistant") {
            commitStream(repoId);
            for (const seg of formatMarkdownLite(rec.text)) pushLine(repoId, seg.text, seg.tone);
          } else {
            pushLine(repoId, rec.text, "dim");
          }
        }
      },
    [pushLine, scheduleStreamDelta, commitStream],
  );

  // ST1(0.9.4 T1)→ST11(0.10.0 A3b) — repoId별로 세션을 지연 생성·재사용한다(sessionsRef Map). Enter/
  // Ctrl+N으로 탭에 opt-in해도 프로세스는 아직 안 뜬다 — 실제 spawn은 그 탭에서 첫 submit()이 일어날
  // 때뿐이다("lazy spawn" 계약의 정확한 위치). buildSessionOptionsForRepo(ST2)로 cwd를 repoId 그
  // 자체로 강제해 원자 결박을 보장한다. onEnded는 이 repoId의 탭 상태를 dead로 갱신하고, 지금 보고
  // 있는 탭일 때만 배너를 띄운다(백그라운드 죽음은 사이드바 아이콘이 대신 알린다, ST9).
  const getOrCreateSession = useCallback(
    async (repoId: string): Promise<EngineSession> => {
      const existing = sessionsRef.current.get(repoId);
      if (existing) return existing;
      // GBC_CLAUDE_PATH(0.9.2 ST5) — cli.ts cmdRun과 동일 우회 seam(engine.ts claudeExecutablePath).
      const claudeExecutablePath = process.env.GBC_CLAUDE_PATH;
      const resume = getLastSessionId(repoId) ?? undefined;
      const session = await createEngineSessionWithResumeFallback(
        buildSessionOptionsForRepo(repoId, {
          ...(model ? { model } : {}),
          ...(claudeExecutablePath ? { claudeExecutablePath } : {}),
          ...(resume ? { resume } : {}),
          includePartialMessages: true,
          preToolUse: makeSdkPreToolUseHook(repoId, undefined, makeOnGateDecision(repoId)),
          canUseTool: makeInkCanUseTool(repoId),
          onMessage: makeHandleEngineMessage(repoId),
          onEnded: (info) => {
            sessionsRef.current.delete(repoId);
            setTabs((prev) => updateTabStatus(prev, repoId, { status: "dead" }));
            // 0.10.4 ST2 — activeTabId 가드 제거: per-repo 버퍼라 배경 탭 배너도 그 탭에 안전히
            // 쌓이고, 사용자가 나중에 그 탭으로 돌아오면 확인할 수 있다(사이드바 ✖ 아이콘과 상보).
            pushLine(repoId, `🐢 세션이 종료되어 다음 메시지부터 새 세션으로 다시 시작합니다. (${info.reason.slice(0, 80)})`, "warn");
          },
        }),
      );
      sessionsRef.current.set(repoId, session);
      return session;
    },
    [model, makeInkCanUseTool, makeOnGateDecision, makeHandleEngineMessage, pushLine],
  );

  const submit = useCallback(
    async (prompt: string) => {
      const repoId = tabsRef.current.activeTabId;
      pushSegments(repoId, [
        { text: INPUT_PROMPT_PREFIX, tone: "accent" },
        { text: prompt, tone: "plain" },
      ]);
      dispatch({ type: "TURN_START" });
      setScrollOffset(0); // SubTask3 — 새 제출 시 대화창 최하단으로 강제 복귀.
      // no-session/alive/dead → streaming(전부 유효 전이, tabs.ts TRANSITIONS) — opt-in 첫 제출·
      // 후속 제출·재접속(respawn) 전부 이 한 줄로 커버된다.
      setTabs((prev) => updateTabStatus(prev, repoId, { status: "streaming" }));
      const turnStartedAt = Date.now(); // ST15(0.9.2) — statusline lastTurnMs 계산용
      try {
        const session = await getOrCreateSession(repoId);
        // 0.10.4 ST5(개선1) — "/name [args]" 형태고 name이 스캔된 스킬과 일치하면, 그 SKILL.md
        // 본문을 클라이언트측에서 읽어 프롬프트에 합성 주입한다(engine.ts settingSources:[] 불변식
        // 때문에 SDK가 스킬을 자체 로드하지 않으므로 이게 유일한 발동 경로 — slash.ts 모듈 주석
        // 참조). 스크롤백 에코(위 pushSegments)는 이미 원문 prompt로 끝났으므로 주입 본문은
        // 화면에 노출되지 않는다.
        const slashMatch = prompt.match(/^\/([A-Za-z0-9_-]+)(?:\s|$)/);
        const matchedSkill = slashMatch ? slashSkills.find((s) => s.name === slashMatch[1]) : undefined;
        const skillBody = matchedSkill ? loadSkillBody(matchedSkill.path) : null;
        const effectivePrompt = skillBody ? composeSkillPrompt(skillBody, prompt) : prompt;
        const result = await session.submit(effectivePrompt);
        // EngineSession.submit()도 runEngine과 동일 계약(rethrow하지 않음, engine.ts) — 인증/네트워크
        // 실패·중단 어느 쪽도 반환값으로만 알 수 있다(0.9.1 실사용자 보고 교훈 승계).
        commitStream(repoId); // 턴 종료 — 동적 영역에 델타 잔여가 남아있으면 정리(중단된 턴 방어)
        if (result.isError && result.error?.startsWith("SESSION_ENDED")) {
          // ST2(0.9.4) 감지 → 여기서 실제 복구: 죽은 세션을 버리고 다음 submit()이 새로 만들게 한다.
          // (0.10.0 ST5) onEnded가 유휴 사망을 이미 잡았다면 이 분기는 "이 submit() 자체가 대기
          // 중이던 도중 죽은" 레이스만 남는다.
          sessionsRef.current.delete(repoId);
          setTabs((prev) => updateTabStatus(prev, repoId, { status: "dead" }));
          // 0.10.4 ST2 — activeTabId 가드 제거(pushLine이 repoId 버퍼에 직접 적재, 결함1 근본수정).
          pushLine(repoId, "🐢 세션이 종료되어 다음 메시지부터 새 세션으로 다시 시작합니다.", "warn");
        } else {
          setTabs((prev) => updateTabStatus(prev, repoId, { status: "alive", sessionId: session.sessionId }));
          // 중단(aborted)은 사용자가 의도한 취소라 실패(danger)와 다른 톤(warn)으로 먼저 본다.
          const abortMsg = formatEngineAbort(result);
          const fallbackMsg = formatResumeFallbackBanner(result); // 0.10.0 ST5 — resume 실패→새 세션 재시도 고지
          if (abortMsg) {
            pushLine(repoId, abortMsg, "warn");
          } else {
            const failureMsg = formatEngineFailure(result);
            if (failureMsg) pushLine(repoId, failureMsg, "danger");
          }
          if (fallbackMsg) pushLine(repoId, fallbackMsg, "warn");
          if (!result.isError && result.sessionId) {
            // 0.10.0 ST7 — 이 repo의 마지막 session_id를 영속(다음 gbc tui 재시작 시 resume 후보).
            try {
              setLastSessionId(repoId, result.sessionId);
            } catch {
              // 로컬 편의기능 — 실패해도 이번 턴 자체는 이미 정상 완료됨.
            }
          }
        }
      } catch (e) {
        commitStream(repoId);
        // agent-sdk는 engine.ts가 lazy dynamic import한다(첫 프롬프트 제출 시점) — ink/react와 달리
        // cli.ts의 cmdTui try/catch는 이 실패를 못 잡는다(ST6 scope-critic 발견). 여기서 별도로
        // 친절 안내하지 않으면 사용자는 잘린 스택트레이스만 본다. 분류는 bridge.ts
        // formatSessionStartFailure(모듈미설치/spawn EPERM/폴백 3분기, formatEngineFailure와
        // 동일 classifySpawnPermissionError 재사용)가 전담 — 0.10.1: spawn EPERM이 안내 없이
        // 원문 노출되던 결함(2026-07-20 실기 재현)을 이 경로에도 배선. 0.10.4 ST2 — activeTabId
        // 가드 제거(pushLine이 repoId 버퍼에 직접 적재).
        pushLine(repoId, formatSessionStartFailure(String(e)), "danger");
      } finally {
        if (repoId === tabsRef.current.activeTabId) {
          dispatch({ type: "TURN_END" });
          const g = detectGit(repoId);
          dispatch({
            type: "STATUSLINE_UPDATE",
            patch: { branch: g.branch, dirty: g.dirty, lastTurnMs: Date.now() - turnStartedAt },
          });
        }
      }
    },
    [getOrCreateSession, pushLine, pushSegments, commitStream, slashSkills],
  );

  // ST11 — 탭 전환/opt-in. TuiState를 새 탭 기준으로 완전히 재시드한다(model.ts TAB_SWITCHED).
  // 0.10.4 ST2 — scrollback은 더 이상 초기화하지 않는다(결함1 근본수정): per-repo 버퍼(scrollback.ts)
  // 덕분에 화면 이력이 repoId별로 그대로 보존되고, 렌더가 activeTabId 버퍼로 자동 전환된다.
  // ensureTab이 이미 등록된 탭이면 no-op이라 기존 세션은 그대로 살아있다.
  const switchToTab = useCallback(
    (repoId: string) => {
      setTabs((prev) => setActiveTab(ensureTab(prev, repoId), repoId));
      const g = detectGit(repoId);
      dispatch({
        type: "TAB_SWITCHED",
        dir: repoId,
        branch: g.branch,
        dirty: g.dirty,
        model: model ?? "",
        specCount: readSpecCases(repoId).length,
        deferCount: activeDeferItems(repoId).length,
      });
      // 0.10.4 ST2(결함1) — 전환 안내 리셋 폐기(사용자 확정). per-repo 버퍼(scrollback.ts)가 그
      // 탭의 이력을 그대로 보존하므로 지울 이유가 없다 — 지금 어느 repo에 있는지는 사이드바 ❯·
      // statusline이 이미 표시한다.
      setScrollOffset(0); // SubTask3 — 탭 전환 시에도 대화창 최하단으로.
    },
    [model],
  );

  // ST11 — opt-out 시퀀스: 이 repo에 대기 중인 승인을 전부 거부로 플러시 → 세션 interrupt → close.
  // 큐에서 이 repoId 항목만 골라내(다른 탭의 대기는 절대 건드리지 않음) 처리한다. 마지막 탭(cwd)은
  // tabs.ts removeTab이 스스로 거부한다(항상 최소 1탭 유지).
  const optOutTab = useCallback(
    async (repoId: string) => {
      const flushed = approvalQueue.current.filter((item) => item.repoId === repoId);
      approvalQueue.current = approvalQueue.current.filter((item) => item.repoId !== repoId);
      for (const item of flushed) item.resolve({ choice: "n" });
      if (flushed.length > 0 && repoId === tabsRef.current.activeTabId && stateRef.current.approval) {
        dispatch({ type: "APPROVAL_ANSWERED", choice: "n" });
      }
      const session = sessionsRef.current.get(repoId);
      if (session) {
        try {
          await session.interrupt();
        } catch {
          // 이미 죽은 세션일 수 있음 — close()는 어차피 아래서 시도.
        }
        session.close();
        sessionsRef.current.delete(repoId);
      }
      setTabs((prev) => {
        const next = removeTab(prev, repoId);
        if (next.activeTabId !== prev.activeTabId) {
          const g = detectGit(next.activeTabId);
          dispatch({
            type: "TAB_SWITCHED",
            dir: next.activeTabId,
            branch: g.branch,
            dirty: g.dirty,
            model: model ?? "",
            specCount: readSpecCases(next.activeTabId).length,
            deferCount: activeDeferItems(next.activeTabId).length,
          });
          // 0.10.4 ST2 — 전환 안내 리셋 폐기(switchToTab과 동일 근거).
          setScrollOffset(0); // SubTask3 — opt-out 후 활성 탭이 바뀔 때도 최하단으로.
        }
        return next;
      });
    },
    [model],
  );

  // 0.10.4 ST5(개선1) — 슬래시 드롭다운 판정(파생 상태, editorState 첫 줄에서 매 렌더 재계산).
  // 별도 open useState가 없으므로 백스페이스로 "/"가 지워지는 등 에디터-드롭다운 desync 클래스가
  // 구조적으로 불가능하다(computeSlashQuery가 그 렌더의 실제 텍스트를 보고 매번 새로 판정).
  const rawSlashQuery = editorState.lines.length === 1 ? computeSlashQuery(editorState.lines[0]) : null;
  const slashOpen = rawSlashQuery !== null && slashSuppressedFor !== editorState.lines[0];
  const slashCandidates = slashOpen ? filterSkills(slashSkills, rawSlashQuery ?? "") : [];
  const slashCursorClamped = Math.min(slashCursor, Math.max(0, slashCandidates.length - 1));
  const slashWindow = slashOpen ? computeSidebarWindow(slashCandidates.length, slashCursorClamped, 5) : { start: 0, end: 0, aboveCount: 0, belowCount: 0 };
  const slashVisibleItems = slashCandidates.slice(slashWindow.start, slashWindow.end);
  // 테두리(2) + (위/아래 인디케이터 각 0~1) + 최소 1행(후보 0개여도 "일치 없음" 안내가 1행 필요).
  const dropdownRows = slashOpen
    ? 2 + (slashWindow.aboveCount > 0 ? 1 : 0) + (slashWindow.belowCount > 0 ? 1 : 0) + Math.max(1, slashVisibleItems.length)
    : 0;

  useEffect(() => {
    setSlashCursor(0);
  }, [editorState.lines[0]]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      // ink render()가 exitOnCtrlC:false로 뜨므로(cli.ts) 즉시종료가 아니라 여기서 2단 확인을 직접
      // 구현한다. 승인 프롬프트·패널이 열려있어도 Ctrl+C는 전역으로 먼저 처리(고무도장 방지 흐름을
      // 방해하지 않으면서도 항상 탈출구가 있어야 함).
      if (state.exitConfirmArmed) {
        process.exit(0);
      }
      dispatch({ type: "CTRL_C_PRESSED" });
      pushLine(tabsRef.current.activeTabId, "🐢 종료하려면 Ctrl+C를 한 번 더 누르세요(2초 내)", "warn");
      if (exitConfirmTimerRef.current) clearTimeout(exitConfirmTimerRef.current);
      exitConfirmTimerRef.current = setTimeout(() => {
        dispatch({ type: "CTRL_C_RESET" });
      }, 2000);
      return;
    }

    // ST11 — 탭 전환 전역키(Alt+1..9, kitty 지원 터미널은 Ctrl+1..9도). 승인 블록보다 먼저 확인한다
    // (critic 지적: 승인이 모든 입력을 삼켜 다른 탭으로 못 넘어가는 문제 차단) — 이 repo 목록의
    // N번째로 opt-in/전환(switchToTab이 ensureTab을 경유해 둘 다 처리). 이미 그 탭이면 no-op.
    // 0.10.3 — 레거시 터미널 인코딩엔 Ctrl+숫자 코드 자체가 없어(C-1은 그냥 '1', C-3은 ESC로 도착)
    // key.ctrl 분기가 실기에서 절대 발화하지 않았다(2026-07-22 현장보고 이슈③). Alt+숫자는 ESC 접두
    // (레거시)·CSI ;3u(kitty) 양쪽에서 key.meta로 안정 도착하므로 meta를 1차 바인딩으로 추가한다.
    // Ctrl 분기는 kitty keyboard protocol 활성 터미널(cli.ts kittyKeyboard:auto)용으로 유지.
    if ((key.ctrl || key.meta) && /^[1-9]$/.test(input)) {
      const idx = Number.parseInt(input, 10) - 1;
      const repos = loadRepos();
      const target = repos[idx];
      if (target && target !== tabsRef.current.activeTabId) switchToTab(target);
      return;
    }

    // ST11 — opt-out 확인(Ctrl+W). 승인 중엔 시작하지 않는다(동시에 두 y/n 확인이 뜨는 모호함 방지).
    if (optOutConfirmRepoId) {
      if (input === "y") {
        const repoId = optOutConfirmRepoId;
        setOptOutConfirmRepoId(null);
        void optOutTab(repoId);
      } else {
        setOptOutConfirmRepoId(null);
        pushLine(tabsRef.current.activeTabId, "🐢 opt-out 취소됨", "dim");
      }
      return;
    }
    if ((key.ctrl || key.meta) && input === "w" && !state.approval) {
      const repoId = tabsRef.current.activeTabId;
      if (repoId === cwd) {
        pushLine(repoId, "🐢 시작 repo 탭은 닫을 수 없습니다(항상 최소 1탭 유지)", "warn");
        return;
      }
      setOptOutConfirmRepoId(repoId);
      pushLine(repoId, `🐢 '${repoId}' 세션을 닫을까요? (y/N — 대기 중인 승인은 거부로 처리됩니다)`, "warn");
      return;
    }

    if (state.approval) {
      const approval = state.approval;
      // generic 승인엔 편집 대상(derivedCase)이 없어 resolveApproval이 e를 n과 동일(deny) 처리한다
      // (bridge.ts) — ApprovalBox의 GENERIC_LABEL("거부 (e=n)")과 일치시키려면 여기서도 편집 서브플로우
      // 대신 즉시 답변으로 보내야 한다. spec-add만 실제 편집이 유효하다(2차 자체검토로 발견해 수정).
      const openEdit = () => {
        setApprovalEditor(Editor.insertText(Editor.createInitialState(), approval.derivedCase ?? ""));
        setApprovalEditing(true);
      };
      const answer = (choice: ApprovalChoice, editedText?: string) => {
        dispatch({ type: "APPROVAL_ANSWERED", choice });
        approvalQueue.current[0]?.resolve({ choice, editedText });
      };
      if (approvalEditing) {
        if (key.return) {
          const text = Editor.getText(approvalEditor);
          setApprovalEditing(false);
          answer("e", text);
          return;
        }
        if (key.escape) {
          setApprovalEditing(false);
          return;
        }
        setApprovalEditor((s) => applyEditorKey(input, key, s));
        return;
      }
      if (input === "y" || input === "n" || input === "d") {
        answer(input as ApprovalChoice);
        return;
      }
      if (input === "e") {
        if (approval.kind === "spec-add") openEdit();
        else answer("e");
        return;
      }
      if (key.leftArrow) dispatch({ type: "APPROVAL_SELECTION_MOVE", direction: -1 });
      if (key.rightArrow) dispatch({ type: "APPROVAL_SELECTION_MOVE", direction: 1 });
      if (key.return) {
        const choice = approval.selection;
        if (choice === "e" && approval.kind === "spec-add") {
          openEdit();
          return;
        }
        answer(choice);
      }
      return;
    }

    // 0.10.3 — 패널 토글도 Alt(meta) 폴백 병행. 특히 Ctrl+M은 터미널 레거시 인코딩에서 CR(Enter)과
    // 동일 바이트라 구분 자체가 불가능했다(이슈④ — 메트릭 패널이 레거시 터미널에선 아예 안 열리고
    // Enter 제출로 처리됐다). kitty 활성 터미널에서만 Ctrl+M이 CSI 109;5u로 구분 도착한다.
    if ((key.ctrl || key.meta) && input === "m") {
      dispatch({ type: "TOGGLE_PANEL", panel: "metrics" });
      return;
    }
    if ((key.ctrl || key.meta) && input === "r") {
      dispatch({ type: "TOGGLE_PANEL", panel: "repos" });
      return;
    }
    if ((key.ctrl || key.meta) && input === "s") {
      dispatch({ type: "TOGGLE_PANEL", panel: "skills" });
      return;
    }
    if ((key.ctrl || key.meta) && input === "t") {
      // 0.11.0(사용자 확정) — 타이틀 헤더 full(압축 워드마크 7행)↔mini(1행) 토글. 시안
      // 아티팩트 a9ee1e59 — A안(full) 기본, B안(mini)은 이 단축키로만 진입.
      dispatch({ type: "TOGGLE_TITLE" });
      return;
    }
    // 0.10.4 ST7(개선3-a) — '?' 도움말 패널. 입력창이 비어있을 때만 발동(아니면 물음표 자체를
    // 타이핑할 수 없어진다 — "이 코드가 맞나요?" 같은 일반 문장에 물음표를 못 쓰는 회귀 방지).
    if (input === "?" && Editor.isEmpty(editorState)) {
      dispatch({ type: "TOGGLE_PANEL", panel: "help" });
      return;
    }
    if (state.panel !== "none") {
      if (key.escape) dispatch({ type: "CLOSE_PANEL" });
      // 0.10.4 ST6(개선2) — repos 패널 키보드 선택. Sidebar 내비게이션(SubTask5, 0.10.1)과 동일
      // 전역 인덱스 관례 — computeSidebarWindow가 스크롤 시에도 같은 인덱스 기준을 쓴다.
      if (state.panel === "repos") {
        const repos = loadRepos();
        if (key.upArrow) {
          setReposPanelCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (key.downArrow) {
          setReposPanelCursor((c) => Math.min(Math.max(0, repos.length - 1), c + 1));
          return;
        }
        if (key.return) {
          const target = repos[reposPanelCursor];
          if (target && target !== tabsRef.current.activeTabId) switchToTab(target);
          dispatch({ type: "CLOSE_PANEL" });
          return;
        }
      }
      return;
    }
    // SubTask3(0.10.1) — 대화창 스크롤(ⓒ). 승인·패널 열림 중엔 위 두 early return이 이미 이
    // 지점 도달 자체를 막는다(대화 뷰포트가 그 상태에선 안 보이므로 스크롤 대상이 없다는 게
    // braintrust 권장 정책 — 실기 검증에서 어색하면 뒤집을 수 있는 결정, computeChatViewport가
    // 과대 offset을 항상 안전하게 클램프하므로 여기서 상한을 알 필요는 없다).
    if (key.pageUp) {
      setScrollOffset((o) => o + PGSCROLL_STEP);
      return;
    }
    if (key.pageDown) {
      setScrollOffset((o) => Math.max(0, o - PGSCROLL_STEP));
      return;
    }
    // 0.10.4 ST5(개선1) — 슬래시 드롭다운 키 라우팅. Tab(사이드바 포커스 토글) 앞에 둬야 드롭다운이
    // 열려 있을 때 Tab이 완성 선택으로 먼저 소비된다(계획 명시 순서). ↑/↓/Esc는 후보 유무와 무관하게
    // 항상 드롭다운이 처리하고, Enter/Tab은 후보가 있을 때만 완성으로 소비한다 — 후보 0개(예: 오타)면
    // 여기서 return하지 않고 아래로 흘려보내 사용자가 리터럴 텍스트를 그대로 제출할 수 있게 한다.
    if (slashOpen) {
      if (key.upArrow) {
        setSlashCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setSlashCursor((c) => Math.min(Math.max(0, slashCandidates.length - 1), c + 1));
        return;
      }
      if (key.escape) {
        setSlashSuppressedFor(editorState.lines[0] ?? "");
        return;
      }
      if ((key.return || key.tab) && slashCandidates.length > 0) {
        const target = slashCandidates[slashCursorClamped];
        const completed = completeSlashText(target.name);
        setEditorState((s) => ({ ...s, lines: [completed], cursorRow: 0, cursorCol: completed.length }));
        return;
      }
    }
    // SubTask5(0.10.1) — 사이드바 repos 키보드 내비게이션(Tab 포커스 토글). 승인·패널 열림 중엔
    // 위 early return들이 이미 이 지점 도달을 막는다(PgUp/PgDn과 동일 근거) — 별도 가드 불필요.
    if (key.tab) {
      setSidebarFocused((f) => !f);
      return;
    }
    if (sidebarFocused) {
      // ⌃1..9 직행 단축키(위에서 이미 처리됨)와 달리 이 경로는 창이 스크롤돼 9번째 이후로 밀린
      // repo도 커서로 닿을 수 있다 — Sidebar.tsx computeSidebarWindow가 같은 전역 인덱스를 쓴다.
      const repos = loadRepos();
      if (key.upArrow) {
        setSidebarCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setSidebarCursor((c) => Math.min(Math.max(0, repos.length - 1), c + 1));
        return;
      }
      if (key.return) {
        const target = repos[sidebarCursor];
        if (target && target !== tabsRef.current.activeTabId) switchToTab(target);
        setSidebarFocused(false);
        return;
      }
      if (key.escape) {
        setSidebarFocused(false);
        return;
      }
      // 포커스 중엔 그 외 키(타이핑 등)가 에디터로 새지 않게 전부 여기서 삼킨다.
      return;
    }
    if (key.escape) {
      // ST3(0.9.2)→ST1(0.9.4 T1로 대체) — 스트리밍 중일 때만 중단. 유휴 상태에서 Esc는 여전히
      // no-op(전역 종료 단축키 아님 — Ctrl+C 2단 확인종료가 그 역할). AbortController.abort() 대신
      // EngineSession.interrupt()를 쓴다(ST0 스파이크 실측: SDK interrupt()는 non-blocking, throw 없이
      // result{error_during_execution}으로 종료 — engine.ts buildEngineResultFromResult가 재해석).
      if (state.streaming) void sessionsRef.current.get(tabsRef.current.activeTabId)?.interrupt();
      return;
    }
    if (key.return && key.shift) {
      setEditorState(Editor.newline(editorState));
      return;
    }
    if (key.return) {
      const { text, state: nextEditor } = Editor.commitSubmit(editorState);
      setEditorState(nextEditor);
      if (text && !state.streaming) void submit(text);
      return;
    }
    setEditorState((s) => applyEditorKey(input, key, s));
  });

  // SubTask2(0.10.1)→0.11.0 — ChatBox와 좌측 스택(카드+사이드바)이 같은 세로 높이를 공유한다
  // (시안 요구: "대화창은 좌측 컬럼과 동일한 세로 높이"). 구현은 leftStackRef를 measureElement로
  // 실측해 ChatBox 높이를 역산하는 순환 구조였으나, 이 실측↔렌더 순환 자체가 Frame.tsx와 동일한
  // 결함 클래스(alignItems:stretch 자기충족 고정점 — 특정 터미널 폭에서 무한 리렌더 크래시까지
  // 유발)의 마지막 잔여 인스턴스였다. 헤더가 상시 렌더로 바뀌며 chatHeaderRows도 정적값이 됐으니
  // (구 splashDismissed 조건 분기 폐기) 이제 두 컬럼 모두 정적 산술로 확정할 수 있다 — 측정을
  // 완전히 제거한다. leftStack Box에 이 값을 height로 명시하면, Sidebar 내부 flexGrow 스페이서가
  // 남는 여백을 흡수해 마스코트가 항상 컬럼 하단에 붙는다(레퍼런스: Sidebar.tsx 최하단 스페이서).
  const chatHeaderRows = computeHeaderRows(frameLayout.innerColumns, state.titleMode);
  const chatTotalRows = computeChatRegionRows(rows, frameLayout.bandRows, chatHeaderRows);
  const chatOuterColumns = Math.max(0, computeContentColumns(frameLayout.innerColumns, SIDEBAR_COLUMNS) - CHAT_COLUMN_GAP);
  const chatInnerColumns = Math.max(1, chatOuterColumns - 4); // ChatBox 테두리2+paddingX(1×2)
  // 입력창(또는 승인박스)이 실제로 차지할 행수 — 프롬프트("❯ ")·커서(█)까지 포함해 에디터 텍스트를
  // 표시폭으로 랩한 결과다. shift+↵ 개행·긴 입력 랩·승인박스 프리뷰로 하단부가 늘어나는 만큼 대화
  // 뷰포트를 줄여 박스 총높이(chatTotalRows)를 불변으로 유지한다(0.10.3 — 이슈② 성장 갈래 근본수정).
  const approvalPreviewRows = computePreviewRowBudget(rows, PREVIEW_RESERVED_ROWS + frameLayout.bandRows * 2);
  let inputContentRows: number;
  if (state.approval) {
    // ApprovalBox 레이아웃 근사: 제목1 + 본문(tailLines 프리뷰를 표시폭 랩한 실행수) + 근거/안내1
    // + 여백1 + 선택지1(편집 중엔 안내 1줄뿐). 접두어("gbc spec add " 등) 폭 오차 ±1행은 ChatBox
    // 외곽 overflow hidden이 방어한다(게이트줄이 잠시 잘리는 게 프레임 전체가 밀리는 것보다 낫다).
    const a = state.approval;
    const previewSource = a.kind === "generic" ? a.reason : approvalEditing ? Editor.getText(approvalEditor) : a.derivedCase ?? "";
    const previewVisual = wrapSegmentLine(
      [{ text: tailLines(previewSource ?? "", approvalPreviewRows), tone: "plain" }],
      chatInnerColumns,
    ).length;
    inputContentRows = 1 + previewVisual + (approvalEditing ? 1 : 3);
  } else {
    inputContentRows = 0; // 아래 inputLayout.lines.length로 확정 — 선언 순서상 임시값.
  }
  // 입력창 시각행+캐럿 좌표(0.10.3 IME) — 렌더·행수예산·실커서 위치가 전부 이 한 계산에서 나온다
  // (computeInputLayout 주석 참조). 입력창 내부폭 = 대화 콘텐츠폭 − 입력박스 테두리2 − paddingX2.
  const inputInnerColumns = Math.max(1, chatInnerColumns - 4);
  const inputLayout = state.approval
    ? null
    : computeInputLayout(editorState.lines, editorState.cursorRow, editorState.cursorCol, inputInnerColumns);
  if (inputLayout) inputContentRows = inputLayout.lines.length;
  // dropdownRows(0.10.4 ST5) — 슬래시 드롭다운이 열려 있으면 그만큼 뷰포트에서 차감해 박스 총높이
  // 계약(chatTotalRows)을 불변으로 유지한다(이슈② 재발 방지 원칙 그대로 적용).
  const chatViewportRows = Math.max(
    1,
    chatTotalRows - CHAT_BOX_CHROME_ROWS - CHAT_BOTTOM_CHROME_ROWS - inputContentRows - dropdownRows,
  );

  // 실터미널 커서를 캐럿 위치에 노출(0.10.3) — IME(한글) 조합 중 글자는 터미널이 커서 위치에
  // 그려준다(ink useCursor 공식 용도). 가짜 '█' 문자 커서를 걷어낸 이유: 실커서가 숨겨져 있으면
  // 조합 프리뷰가 표시될 곳이 없어 글자가 다음 키입력(커밋 시점)에야 나타난다(사외 실사용 보고).
  // 좌표는 전부 정적 산술 — x: 거터+사이드바34+갭1+대화박스(테두리1+패딩1)+입력박스(테두리1+패딩1),
  // y: 상단밴드+헤더+대화박스(테두리1+인디케이터1)+뷰포트+입력박스 테두리1.
  const { setCursorPosition } = useCursor();
  const caretVisible = inputLayout !== null && state.panel === "none" && !sidebarFocused;
  if (caretVisible && inputLayout) {
    // +1 보정(2026-07-22 tmux 실측): ink buildCursorSuffix는 "커서가 마지막 출력행 다음 줄에
    // 있다"를 전제로 위로 이동량을 계산하는데, 우리 레이아웃은 출력이 터미널 행수를 정확히 채우는
    // 정적 설계라 커서가 최하단 행에서 클램프돼 전제가 1행 깨진다 — 실측 y=33 vs 실제 입력행 34.
    setCursorPosition({
      x: frameLayout.gutterColumns + SIDEBAR_COLUMNS + CHAT_COLUMN_GAP + 2 + 2 + inputLayout.caretCol,
      y: frameLayout.bandRows + chatHeaderRows + 2 + chatViewportRows + 1 + dropdownRows + inputLayout.caretRow + 1,
    });
  } else {
    setCursorPosition(undefined);
  }

  // 0.10.4 ST2 — 렌더는 항상 "지금 활성 탭"의 버퍼만 그린다. getBuffer는 해당 repoId 배열의
  // 참조를 그대로 반환하므로(scrollback.ts appendEntry가 건드린 repoId 키만 새 배열이 됨), 다른
  // repo에 append가 일어나도 activeScrollBuffer 참조는 안 바뀌어 이 useMemo가 불필요하게
  // 무효화되지 않는다.
  const activeScrollBuffer = getBuffer(scrollBuffers, tabs.activeTabId);
  const chatEntries = useMemo<ChatEntry[]>(
    () =>
      activeScrollBuffer.map((e) =>
        e.kind === "segments" ? { id: e.id, segments: e.segments } : { id: e.id, segments: [{ text: e.text, tone: e.tone }] },
      ),
    [activeScrollBuffer],
  );

  return (
    // 0.10.1 — 외부 '+' 프레임(braintrust 확정)이 화면 전체를 감싼다. Frame은 동적 영역(헤더+
    // 좌측 스택+대화 컬럼) 바깥쪽 장식만 담당한다.
    <Frame columns={columns} rows={rows}>
      {/* SubTask10 — 워드마크는 사이드바까지 포함한 전체 화면 폭 기준으로 좌우 스택 위에 1회
          그린다(승인 시안). 0.11.0(사용자 확정) — 더 이상 첫 제출로 소멸하지 않고 항상 렌더된다.
          state.titleMode(full/mini)만 ⌃T로 바뀐다(useInput 배선 참조). */}
      {/* 2026-07-21 — marginLeft(빈 공백) 대신 leftMargin prop으로 넘긴다: SplashHeader가 그
          여백을 '+' 채움 열로 직접 그려야 프레임 텍스처가 Title Area 안까지 이어진다(사용자
          요청 — 외곽선뿐 아니라 내부 배경도 채움). 상단 여백행(구 topMarginRows)은 0.11.0 헤더
          압축으로 제거됐다. */}
      <SplashHeader columns={frameLayout.innerColumns} version={version} mode={state.titleMode} leftMargin={HERO_LEFT_MARGIN} />
      {/* ST10(0.10.0 A3b) — 터틀 덱 2컬럼: 좌측 상시 스택(카드+사이드바, 고정폭)+우측 대화 컬럼
          (가변폭, flexGrow). 사이드바는 토글 패널 시스템(state.panel)과 별개 축이라 ⌃M/⌃R/⌃S
          기존 동작은 무변경. SubTask10 — 카드가 사이드바와 동일폭 34로 이 스택에 합류한다. */}
      {/* alignItems="flex-start" — 0.11.0부터 두 컬럼 높이가 measureElement 없이 정적 산술
          (chatTotalRows)로만 결정되므로 stretch로 인한 순환 크래시(2026-07-21 실측, 특정 폭에서
          "Maximum update depth exceeded")는 이제 구조적으로 불가능하다. 그래도 stretch 기본값을
          그대로 두면 두 컬럼이 서로의 자연높이로 늘어나려 해 불필요한 재계산이 생기므로 명시
          유지한다(방어적 관례, 필수는 아님). */}
      <Box flexDirection="row" columnGap={CHAT_COLUMN_GAP} alignItems="flex-start">
        {/* flexShrink=0 필수(2026-07-21 통합 실기검증 실측) — SkillsPanel처럼 폭 제약 없는 우측
            콘텐츠(설명 최대 80자)가 있으면 Yoga 기본 flexShrink=1이 이 컨테이너 자체를 쪼그라뜨려
            카드/사이드바 폭(34) 테두리가 겹쳐 깨진다. Sidebar.tsx 자체엔 이미 flexShrink=0이 있지만
            그건 개별 자식만 보호할 뿐, 부모 컨테이너가 행 축에서 쪼그라드는 건 못 막는다. */}
        {/* height=chatTotalRows(0.11.0 정적 전환) — 이 컬럼과 ChatBox가 같은 높이를 갖도록 명시
            고정한다. WelcomeCard·Sidebar 실콘텐츠가 이보다 짧으면 Sidebar 내부 flexGrow
            스페이서가 남는 세로공간을 흡수해 마스코트를 컬럼 하단에 붙인다. */}
        <Box flexDirection="column" flexShrink={0} height={chatTotalRows}>
          <WelcomeCard specCount={state.specCount} deferCount={state.deferCount} skills={cardSkills} />
          <Sidebar cwd={cwd} tabs={tabs} focused={sidebarFocused} cursor={sidebarCursor} />
        </Box>
        {/* SubTask2(0.10.1) — 대화영역 박스 상주(시안 ff0eb0b1). Static을 완전히 걷어내고 ChatBox가
            scrollback 전량을 시각행 윈도잉으로 그린다. 패널·승인은 대화 뷰포트/입력창 자리를
            대체하되 ChatBox 자체 테두리·행 예산은 그대로다(ⓓ, 상세는 ChatBox.tsx 주석). */}
        <ChatBox
          innerWidth={chatInnerColumns}
          viewportRows={chatViewportRows}
          totalRows={chatTotalRows}
          entries={chatEntries}
          scrollOffset={scrollOffset}
          showWelcome={activeScrollBuffer.length === 0}
          panelNode={
            state.panel === "metrics" ? (
              <MetricsPanel cwd={cwd} />
            ) : state.panel === "repos" ? (
              // 0.10.4 ST6 — contentColumns는 ChatBox 자체의 테두리+패딩(4)·컬럼갭(1)까지 뺀
              // chatInnerColumns여야 한다. 기존엔 computeContentColumns(...) 원값(그 5컬럼을 포함한
              // 값)을 그대로 넘겨 REPOS_PANEL_ROW_OVERHEAD 예산이 실제보다 5컬럼 더 넓다고 착각—
              // 긴 경로가 실제 렌더 폭에서 줄바꿈돼 패널 행수가 예산을 초과하고 알트스크린 잔상이
              // 발생했다(백로그 "ReposPanel 세로 오버플로"의 실체, tmux 실기 검증으로 확인).
              <ReposPanel cwd={cwd} contentColumns={chatInnerColumns} cursor={reposPanelCursor} />
            ) : state.panel === "skills" ? (
              <SkillsPanel cwd={cwd} />
            ) : state.panel === "help" ? (
              <HelpPanel />
            ) : undefined
          }
          // ST5(0.9.4 T2)→0.10.3 — 프리뷰가 별도 노드가 아니라 대화 시각행 윈도우 안에서 스크롤백
          // 뒤에 이어 렌더된다(ChatBox 주석 참조 — 예산 외 추가 행이 프레임을 밀던 이슈② 근본수정).
          // 완성되면 commitStream()이 streamingText를 비우는 동시에 같은 텍스트가 scrollback에
          // 커밋된다(이중출력 방지). 스피너는 인디케이터 행에 병합된다.
          streamingText={state.streaming && !state.approval ? state.streamingText : undefined}
          spinnerText={state.streaming && !state.approval ? formatSpinnerLine(spinnerTick, elapsedMs) : undefined}
        >
          {state.approval ? (
            <ApprovalBox
              approval={state.approval}
              editing={approvalEditing}
              editText={Editor.getText(approvalEditor)}
              previewRows={approvalPreviewRows}
            />
          ) : (
            <>
              {/* 0.10.4 ST5(개선1) — 슬래시 드롭다운은 입력창 바로 위에 뜬다. dropdownRows가 이미
                  뷰포트에서 차감·캐럿 y에 가산됐으므로(위 계산 참조) 여기 추가로 그려도 프레임
                  총높이가 늘지 않는다. */}
              {slashOpen && (
                <SlashDropdown
                  items={slashVisibleItems}
                  aboveCount={slashWindow.aboveCount}
                  belowCount={slashWindow.belowCount}
                  cursorIndexInWindow={slashCursorClamped - slashWindow.start}
                />
              )}
              {/* 0.10.3 — computeInputLayout의 시각행을 그대로 한 행씩 렌더(ink 자체 랩 미사용 —
                  계산과 렌더가 다른 랩 규칙을 쓰면 캐럿 좌표·행수예산이 어긋난다). 가짜 '█' 폐기,
                  캐럿은 실터미널 커서(useCursor 배선)가 표시한다. */}
              <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
                {(inputLayout?.lines ?? [INPUT_PROMPT_PREFIX]).map((ln, i) => (
                  <Text key={i} wrap="truncate">
                    {i === 0 ? (
                      <>
                        <Text color={toneColor("accent")}>{INPUT_PROMPT_PREFIX}</Text>
                        <Text>{ln.slice(INPUT_PROMPT_PREFIX.length) || " "}</Text>
                      </>
                    ) : (
                      <Text>{ln || " "}</Text>
                    )}
                  </Text>
                ))}
              </Box>
            </>
          )}
          {/* 게이트줄·상태줄 1행 클램프(0.10.3) — 좁은 대화 컬럼에서 세그먼트가 랩되며 +1행씩 자라
              박스 총높이 계약을 깨던 갈래 차단. 넘치는 꼬리는 잘리는 게 프레임 밀림보다 낫다. */}
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Segments segments={formatGateLine(state)} />
          </Box>
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Segments segments={formatStatusline(state.statusline)} />
          </Box>
        </ChatBox>
      </Box>
      {/* 2026-07-21(사용자 지시 "최하단 밴드 1행만 잔여") — 2컬럼 섹션 아래 남는 세로 공간
          전부를 '+'로 채워 하단 밴드가 항상 최하단 1행에 바로 이어지게 한다. Frame 콘텐츠
          Box가 innerRows로 높이 고정(정적 전환)이라, flexGrow=1 Box가 잔여 행수를 정확히
          받고 overflow=hidden이 초과분 '+' 행을 클립한다 — 잔여 행수를 산술로 맞출 필요가
          없어(leftStack 높이·헤더 유무에 따라 가변) 채움 개수 계산 결함 클래스가 원천 차단된다.
          frameLayout.enabled 가드 필수(실기검증으로 발견) — Frame이 비활성(80열/30행 미만)이면
          <Frame>은 children을 그대로 통과시킬 뿐 밴드·거터를 전혀 그리지 않는데, 이 가드가
          없으면 프레임 없는 좁은/저행 터미널 하단에 '+' 채움 덩어리가 통째로 남는 회귀가 있다
          (79×29에서 1행짜리로도 실측 재현됐던 회귀의 확장판). */}
      {/* flexBasis=0 필수(실측) — 기본 flexBasis:auto면 내부 '+' 행 innerRows개가 그대로 기본
          크기가 돼(예: 42행) 콘텐츠 총합이 부모 고정 높이를 초과, Yoga가 위 2컬럼 섹션까지
          쥐어짜 카드가 중간에서 잘리고 전체가 위로 밀렸다. 기본 크기 0 + flexGrow로 "잔여
          공간만" 받고, 초과분 '+' 행은 overflow=hidden이 클립한다. */}
      {frameLayout.enabled && (
        <Box flexGrow={1} flexBasis={0} flexDirection="column" overflow="hidden">
          {/* flexShrink=0 내부 래퍼 필수(최소재현 실측) — '+' Text들이 overflow Box의 직접
              자식이면 기본 flexShrink=1이 클립 대신 "수축"을 일으켜 42행이 잔여 2행에 쥐어짜이며
              임의 행만 남는다(FILL20·FILL41처럼 비연속 렌더 → 실기에선 빈 행으로 보임). 수축
              불가 래퍼가 자연 높이를 유지해야 overflow=hidden이 위에서부터 순서대로 클립한다. */}
          <Box flexDirection="column" flexShrink={0}>
            {Array.from({ length: frameLayout.innerRows }, (_, i) => (
              <Text key={i} color={FRAME_COLOR}>
                {"+".repeat(frameLayout.innerColumns)}
              </Text>
            ))}
          </Box>
        </Box>
      )}
    </Frame>
  );
}
