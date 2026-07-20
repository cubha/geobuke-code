// 0.9.0 A3a ST5 — gbc TUI 메인 화면(시안 A: 토글 패널형). ink/react를 이 파일이 직접 정적 import
// 한다 — 격리 경계는 cli.ts→app.tsx의 lazy dynamic import 쪽(ST6)에 있다(ST0 회귀락 대상은 cli.ts).
// 이 파일은 얇은 오케스트레이션+렌더만 한다 — 상태전이는 model.ts/editor.ts, 표시문구는 format.ts,
// 엔진↔TUI 변환은 bridge.ts가 전담(순수, TDD 커버). 여기서 새 판정 로직을 만들지 않는다.
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useInput, useWindowSize, type Key } from "ink";
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
  tailLines,
  SIDEBAR_COLUMNS,
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
import { gbcDir } from "../store.js";
import { nowIso } from "../time.js";
import { Segments } from "./ui/Segments.js";
import { ApprovalBox } from "./ui/ApprovalBox.js";
import { MetricsPanel } from "./ui/MetricsPanel.js";
import { ReposPanel } from "./ui/ReposPanel.js";
import { SkillsPanel } from "./ui/SkillsPanel.js";
import { SplashHero } from "./ui/SplashHero.js";
import { Sidebar } from "./ui/Sidebar.js";
import { toneColor } from "./ui/theme.js";
import { scanSkills } from "./skills.js";
import { GBC_SKILL_NAMES } from "../install.js";

// 0.9.3 D2 — 스플래시 카드용 짧은 blurb(⌃S 패널의 SkillInfo.description 전문과는 별개 — 54칸
// 카드 폭엔 전문이 안 맞아 큐레이션 필요). 이름이 이 표에 없으면 실제 description을 짧게 잘라
// fallback한다(향후 gbc 자체 스킬이 늘어도 조용히 blurb 없는 항목이 되지 않게).
const SPLASH_SKILL_BLURBS: Record<string, string> = {
  gate: "defer·spec·verify 게이트 관리",
  "gbc-monitor": "운영 현황 조회(관측 전용)",
  "gbc-mute": "defer 리마인드 on/off",
};

/** 스플래시 카드에 표시할 gbc 자체 스킬만(GBC_SKILL_NAMES 순서) — 실제 설치 확인은 scanSkills로. */
function resolveCardSkills(cwd: string): CardSkill[] {
  const installed = new Map(scanSkills(cwd).map((s) => [s.name, s]));
  const out: CardSkill[] = [];
  for (const name of GBC_SKILL_NAMES) {
    const found = installed.get(name);
    if (!found) continue; // 미설치(gbc init 안 함) — 조용히 생략
    out.push({ name, blurb: SPLASH_SKILL_BLURBS[name] ?? found.description.slice(0, 40) });
  }
  return out;
}

type ScrollEntry =
  | { id: number; kind: "text"; text: string; tone: Tone }
  // ST13-14(0.9.2) — formatWelcomeCard가 한 줄에 여러 톤을 섞을 수 있는 TextSegment[][]를 반환하는데,
  // "text" variant(단일 tone)로 욱여넣으면 조용히 정보가 손실된다(scope-critic 발견, 2026-07-13
  // ST13-14 판정 DECISION_CHANGED:yes). 기존 <Segments> 렌더 관례(formatGateLine/formatStatusline과
  // 동일)를 그대로 재사용해 세그먼트별 톤을 보존한다.
  | { id: number; kind: "segments"; segments: TextSegment[] }
  // 0.9.3 D2 — 워드마크+마스코트+카드 2컬럼 병치를 하나의 조립 단위로 커밋(개별 Static 엔트리
  // 나열이던 기존 방식은 병치·세로중앙정렬·여백을 표현할 수 없었다 — 사용자 실사용 지적).
  | { id: number; kind: "hero"; columns: number; version: string; specCount: number; deferCount: number; skills: CardSkill[] };

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

  const [scrollback, setScrollback] = useState<ScrollEntry[]>([]);
  const nextId = useRef(0);

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
  const pushLine = useCallback((text: string, tone: Tone = "plain") => {
    setScrollback((s) => [...s, { id: nextId.current++, kind: "text", text, tone }]);
  }, []);

  // ST12(0.10.0 A3b) — 크래시 덤프 4경로. 알트스크린(ST10)은 teardown 프레임을 보존하지 않는다
  // (ink 공식 동작) — 종료 사유 불문 화면이 그냥 사라지므로, 마지막으로 보이던 scrollback을 파일로
  // 남겨야 복구 가능하다. scrollbackRef는 stateRef/tabsRef와 동일한 "항상 최신값" 미러 패턴.
  const scrollbackRef = useRef(scrollback);
  scrollbackRef.current = scrollback;
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
        const text = formatCrashDump(scrollbackRef.current, reason, nowIso());
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
  }, []);

  // 스플래시 — 1회 커밋(Static, 단일 "hero" 엔트리). 0.9.3 D2: 워드마크·마스코트·카드를 각자
  // 독립 Static 엔트리로 나열하던 기존 방식은 병치·세로중앙정렬·여백을 표현할 수 없어(사용자
  // 실사용 지적, 2026-07-14) SplashHero 컴포넌트 하나로 조립을 위임한다 — 여기선 데이터만 모은다.
  useEffect(() => {
    const heroEntry: ScrollEntry = {
      id: nextId.current++,
      kind: "hero",
      // ST10(0.10.0 A3b) — 좌측 사이드바가 상시 폭을 차지하므로, 히어로/대화 컬럼은 전체 터미널
      // 폭이 아니라 그 나머지만 쓸 수 있다(ST9 computeContentColumns, braintrust R1 지적).
      columns: computeContentColumns(columns, SIDEBAR_COLUMNS),
      version,
      specCount: readSpecCases(cwd).length,
      deferCount: activeDeferItems(cwd).length,
      skills: resolveCardSkills(cwd),
    };
    setScrollback((s) => [heroEntry, ...s]);
    dispatch({ type: "SESSION_START" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

        if (repoId !== tabsRef.current.activeTabId) return;
        for (const ev of mapEngineMessageToTuiEvents(msg)) dispatch(ev);
        for (const rec of mapSdkMessage(msg)) {
          if (!rec.text) continue;
          if (rec.kind === "assistant") {
            commitStream(repoId);
            for (const seg of formatMarkdownLite(rec.text)) pushLine(seg.text, seg.tone);
          } else {
            pushLine(rec.text, "dim");
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
            if (repoId === tabsRef.current.activeTabId) {
              pushLine(`🐢 세션이 종료되어 다음 메시지부터 새 세션으로 다시 시작합니다. (${info.reason.slice(0, 80)})`, "warn");
            }
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
      pushLine(`❯ ${prompt}`, "code");
      dispatch({ type: "TURN_START" });
      // no-session/alive/dead → streaming(전부 유효 전이, tabs.ts TRANSITIONS) — opt-in 첫 제출·
      // 후속 제출·재접속(respawn) 전부 이 한 줄로 커버된다.
      setTabs((prev) => updateTabStatus(prev, repoId, { status: "streaming" }));
      const turnStartedAt = Date.now(); // ST15(0.9.2) — statusline lastTurnMs 계산용
      try {
        const session = await getOrCreateSession(repoId);
        const result = await session.submit(prompt);
        // EngineSession.submit()도 runEngine과 동일 계약(rethrow하지 않음, engine.ts) — 인증/네트워크
        // 실패·중단 어느 쪽도 반환값으로만 알 수 있다(0.9.1 실사용자 보고 교훈 승계).
        commitStream(repoId); // 턴 종료 — 동적 영역에 델타 잔여가 남아있으면 정리(중단된 턴 방어)
        if (result.isError && result.error?.startsWith("SESSION_ENDED")) {
          // ST2(0.9.4) 감지 → 여기서 실제 복구: 죽은 세션을 버리고 다음 submit()이 새로 만들게 한다.
          // (0.10.0 ST5) onEnded가 유휴 사망을 이미 잡았다면 이 분기는 "이 submit() 자체가 대기
          // 중이던 도중 죽은" 레이스만 남는다.
          sessionsRef.current.delete(repoId);
          setTabs((prev) => updateTabStatus(prev, repoId, { status: "dead" }));
          if (repoId === tabsRef.current.activeTabId) {
            pushLine("🐢 세션이 종료되어 다음 메시지부터 새 세션으로 다시 시작합니다.", "warn");
          }
        } else {
          setTabs((prev) => updateTabStatus(prev, repoId, { status: "alive", sessionId: session.sessionId }));
          if (repoId === tabsRef.current.activeTabId) {
            // 중단(aborted)은 사용자가 의도한 취소라 실패(danger)와 다른 톤(warn)으로 먼저 본다.
            const abortMsg = formatEngineAbort(result);
            const fallbackMsg = formatResumeFallbackBanner(result); // 0.10.0 ST5 — resume 실패→새 세션 재시도 고지
            if (abortMsg) {
              pushLine(abortMsg, "warn");
            } else {
              const failureMsg = formatEngineFailure(result);
              if (failureMsg) pushLine(failureMsg, "danger");
            }
            if (fallbackMsg) pushLine(fallbackMsg, "warn");
          }
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
        // 원문 노출되던 결함(2026-07-20 실기 재현)을 이 경로에도 배선.
        if (repoId === tabsRef.current.activeTabId) {
          pushLine(formatSessionStartFailure(String(e)), "danger");
        }
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
    [getOrCreateSession, pushLine, commitStream],
  );

  // ST11 — 탭 전환/opt-in. TuiState를 새 탭 기준으로 완전히 재시드하고(model.ts TAB_SWITCHED),
  // scrollback을 초기화한다(per-tab scrollback은 이번 스코프에 없음 — 전환 시 화면 이력이 안 이어지는
  // 건 의도된 단순화다: 실제 대화 맥락은 서버측 resume이 보존하므로 사용자 체감 손실은 "화면
  // 스크롤백만" 이다). ensureTab이 이미 등록된 탭이면 no-op이라 기존 세션은 그대로 살아있다.
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
      setScrollback([{ id: nextId.current++, kind: "text", text: `🐢 ${repoId} 세션으로 전환`, tone: "dim" }]);
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
          setScrollback([{ id: nextId.current++, kind: "text", text: `🐢 ${next.activeTabId} 세션으로 전환`, tone: "dim" }]);
        }
        return next;
      });
    },
    [model],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      // ink render()가 exitOnCtrlC:false로 뜨므로(cli.ts) 즉시종료가 아니라 여기서 2단 확인을 직접
      // 구현한다. 승인 프롬프트·패널이 열려있어도 Ctrl+C는 전역으로 먼저 처리(고무도장 방지 흐름을
      // 방해하지 않으면서도 항상 탈출구가 있어야 함).
      if (state.exitConfirmArmed) {
        process.exit(0);
      }
      dispatch({ type: "CTRL_C_PRESSED" });
      pushLine("🐢 종료하려면 Ctrl+C를 한 번 더 누르세요(2초 내)", "warn");
      if (exitConfirmTimerRef.current) clearTimeout(exitConfirmTimerRef.current);
      exitConfirmTimerRef.current = setTimeout(() => {
        dispatch({ type: "CTRL_C_RESET" });
      }, 2000);
      return;
    }

    // ST11 — 탭 전환 전역키(Ctrl+1..9). 승인 블록보다 먼저 확인한다(critic 지적: 승인이 모든 입력을
    // 삼켜 다른 탭으로 못 넘어가는 문제 차단) — 이 repo 목록의 N번째로 opt-in/전환(switchToTab이
    // ensureTab을 경유해 둘 다 처리). 이미 그 탭이면 no-op.
    if (key.ctrl && /^[1-9]$/.test(input)) {
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
        pushLine("🐢 opt-out 취소됨", "dim");
      }
      return;
    }
    if (key.ctrl && input === "w" && !state.approval) {
      const repoId = tabsRef.current.activeTabId;
      if (repoId === cwd) {
        pushLine("🐢 시작 repo 탭은 닫을 수 없습니다(항상 최소 1탭 유지)", "warn");
        return;
      }
      setOptOutConfirmRepoId(repoId);
      pushLine(`🐢 '${repoId}' 세션을 닫을까요? (y/N — 대기 중인 승인은 거부로 처리됩니다)`, "warn");
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

    if (key.ctrl && input === "m") {
      dispatch({ type: "TOGGLE_PANEL", panel: "metrics" });
      return;
    }
    if (key.ctrl && input === "r") {
      dispatch({ type: "TOGGLE_PANEL", panel: "repos" });
      return;
    }
    if (key.ctrl && input === "s") {
      dispatch({ type: "TOGGLE_PANEL", panel: "skills" });
      return;
    }
    if (state.panel !== "none") {
      if (key.escape) dispatch({ type: "CLOSE_PANEL" });
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

  return (
    // ST10(0.10.0 A3b) — 터틀 덱 2컬럼: 좌측 상시 사이드바(고정폭)+우측 대화 컬럼(가변폭, flexGrow).
    // 사이드바는 토글 패널 시스템(state.panel)과 별개 축이라 ⌃M/⌃R/⌃S 기존 동작은 무변경.
    <Box flexDirection="row">
      <Sidebar cwd={cwd} tabs={tabs} />
      <Box flexDirection="column" flexGrow={1}>
        <Static items={scrollback}>
          {(entry) =>
            entry.kind === "hero" ? (
              <SplashHero
                key={entry.id}
                columns={entry.columns}
                version={entry.version}
                specCount={entry.specCount}
                deferCount={entry.deferCount}
                skills={entry.skills}
              />
            ) : entry.kind === "segments" ? (
              <Segments key={entry.id} segments={entry.segments} />
            ) : (
              <Text key={entry.id} color={toneColor(entry.tone)}>
                {entry.text}
              </Text>
            )
          }
        </Static>
        {state.panel === "metrics" && <MetricsPanel cwd={cwd} />}
        {state.panel === "repos" && (
          <ReposPanel cwd={cwd} contentColumns={computeContentColumns(columns, SIDEBAR_COLUMNS)} />
        )}
        {state.panel === "skills" && <SkillsPanel cwd={cwd} />}
        {/* ST5(0.9.4 T2) — Static 밖 동적 영역: partial 델타 진행 중 표시. 완성되면 commitStream()이
            streamingText를 비우는 동시에 같은 텍스트가 위 Static 스크롤백에 커밋된다(이중출력 방지).
            0.10.0 A3b 실기검증 이슈③ — 이 영역(사이드바 포함 동적 트리 전체)이 터미널 행수를
            넘으면 ink가 이전 프레임을 못 지워 잔상이 쌓인다(tmux 실측: "안녕하세요" 8회 중복).
            tailLines로 마지막 N줄만 렌더 — 완성 텍스트는 무변경으로 Static에 커밋되므로 정보
            손실은 없다(프리뷰만 잘림). */}
        {state.streaming && !state.approval && state.streamingText && (
          <Text>{tailLines(state.streamingText, computePreviewRowBudget(rows))}</Text>
        )}
        {state.streaming && !state.approval && (
          <Text color="green">{formatSpinnerLine(spinnerTick, elapsedMs)}</Text>
        )}
        {state.approval ? (
          <ApprovalBox
            approval={state.approval}
            editing={approvalEditing}
            editText={Editor.getText(approvalEditor)}
            previewRows={computePreviewRowBudget(rows)}
          />
        ) : (
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <Text color="cyan">❯ </Text>
            <Text>{Editor.getText(editorState)}</Text>
            <Text>█</Text>
          </Box>
        )}
        <Segments segments={formatGateLine(state)} />
        <Segments segments={formatStatusline(state.statusline)} />
      </Box>
    </Box>
  );
}
