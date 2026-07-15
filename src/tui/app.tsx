// 0.9.0 A3a ST5 — gbc TUI 메인 화면(시안 A: 토글 패널형). ink/react를 이 파일이 직접 정적 import
// 한다 — 격리 경계는 cli.ts→app.tsx의 lazy dynamic import 쪽(ST6)에 있다(ST0 회귀락 대상은 cli.ts).
// 이 파일은 얇은 오케스트레이션+렌더만 한다 — 상태전이는 model.ts/editor.ts, 표시문구는 format.ts,
// 엔진↔TUI 변환은 bridge.ts가 전담(순수, TDD 커버). 여기서 새 판정 로직을 만들지 않는다.
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useInput, useWindowSize, type Key } from "ink";
import { execSync } from "node:child_process";
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
  DeltaAssembler,
} from "./bridge.js";
import { createEngineSession, mapSdkMessage, type EngineSession } from "../engine.js";
import { makeSdkPreToolUseHook } from "../gate-sdk.js";
import { readSpecCases } from "../spec.js";
import { activeDeferItems, addDefer } from "../defer.js";
import { Segments } from "./ui/Segments.js";
import { ApprovalBox } from "./ui/ApprovalBox.js";
import { MetricsPanel } from "./ui/MetricsPanel.js";
import { ReposPanel } from "./ui/ReposPanel.js";
import { SkillsPanel } from "./ui/SkillsPanel.js";
import { SplashHero } from "./ui/SplashHero.js";
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
  const { columns } = useWindowSize();
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

  const [scrollback, setScrollback] = useState<ScrollEntry[]>([]);
  const nextId = useRef(0);
  // ST1(0.9.4 T1) — 세션 프로세스 재사용. 매 submit()마다 새로 spawn하던 runEngine 대신, 이 ref가
  // 세션이 살아있는 동안 EngineSession 하나를 들고 있는다(대화 연속성). SESSION_ENDED 감지 시(ST2)
  // null로 되돌려 다음 submit()이 자동으로 새 세션을 만들게 한다(kill→재생성 복구).
  const sessionRef = useRef<EngineSession | null>(null);
  // ST3(0.9.4 T2) — partial 델타 어셈블러. index별 누적은 세션 동안 유지해도 안전하다(content_block_stop
  // 때 해당 인덱스가 정리되고, 다음 content_block_start가 항상 그 인덱스를 ""로 재초기화하므로 턴이
  // 중단돼 정리가 안 남아도 다음 사용 시 덮어써진다 — bridge.ts DeltaAssembler 주석 참조).
  const deltaAssemblerRef = useRef(new DeltaAssembler());
  // ST5 — STREAM_DELTA dispatch 스로틀(trailing, ink 30fps 락 위반 방지 — scope-critic ST3 지적 반영).
  const streamThrottleRef = useRef<{ timer: NodeJS.Timeout | null; lastAt: number }>({ timer: null, lastAt: 0 });
  const STREAM_THROTTLE_MS = 80;
  const scheduleStreamDelta = useCallback((text: string) => {
    const t = streamThrottleRef.current;
    if (t.timer) clearTimeout(t.timer);
    const elapsed = Date.now() - t.lastAt;
    const flush = () => {
      t.lastAt = Date.now();
      t.timer = null;
      dispatch({ type: "STREAM_DELTA", text });
    };
    if (elapsed >= STREAM_THROTTLE_MS) flush();
    else t.timer = setTimeout(flush, STREAM_THROTTLE_MS - elapsed);
  }, []);
  const commitStream = useCallback(() => {
    const t = streamThrottleRef.current;
    if (t.timer) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    dispatch({ type: "STREAM_COMMIT" });
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

  // 단일 ref가 아닌 큐 — SDK가 한 턴 안에서 서로 다른 tool_use 2개(예: gated Edit + Bash spec-add)에
  // canUseTool을 겹쳐 호출할 가능성을 코드로 배제할 수 없다(2026-07-10 자체검토로 발견). 단일 ref였다면
  // 두 번째 호출이 첫 번째의 resolver를 덮어써 첫 approval Promise가 영구 대기(leak)했다 — 큐로 직렬화해
  // 화면엔 한 번에 하나만 뜨되 응답 즉시 다음 것을 이어서 연다.
  type QueuedApproval = {
    ctx: ReturnType<typeof classifyApprovalRequest>;
    reason: string;
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
      columns,
      version,
      specCount: readSpecCases(cwd).length,
      deferCount: activeDeferItems(cwd).length,
      skills: resolveCardSkills(cwd),
    };
    setScrollback((s) => [heroEntry, ...s]);
    dispatch({ type: "SESSION_START" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const makeInkCanUseTool = useCallback((): CanUseTool => {
    return async (toolName, input, options) => {
      const ctx = classifyApprovalRequest(toolName, input as Record<string, unknown>);
      const answer = await new Promise<{ choice: ApprovalChoice; editedText?: string }>((resolve) => {
        const item: QueuedApproval = { ctx, reason: options.decisionReason ?? "", resolve };
        const wasEmpty = approvalQueue.current.length === 0;
        approvalQueue.current.push(item);
        // 큐가 비어있었을 때만 즉시 화면에 띄운다 — 이미 뭔가 대기 중이면 그게 응답될 때 이어서 연다.
        if (wasEmpty) activateApproval(item);
      });
      const resolution = resolveApproval(answer.choice, ctx, input as Record<string, unknown>, answer.editedText);
      // ANSWERED dispatch는 useInput의 answer() 헬퍼가 resolve() 직전에 이미 실행한다(3차 자체검토로
      // 발견한 중복 제거 — 여기서 다시 부르면 동일 이벤트가 두 번 발화돼 향후 reducer가 비-멱등 로직을
      // 갖게 될 때 이중 실행 버그의 씨앗이 된다).
      approvalQueue.current.shift();
      if (resolution.deferText) {
        try {
          addDefer(cwd, resolution.deferText);
        } catch {
          // 로컬 TUI 편의기능 — 실패해도 canUseTool 응답(deny)은 이미 확정돼 있어 엔진 흐름은 계속됨.
        }
      }
      const next = approvalQueue.current[0];
      if (next) activateApproval(next);
      return resolution.result;
    };
  }, [cwd, activateApproval]);

  const onGateDecision = useCallback(
    (decision: GateDecision) => {
      const specCount = readSpecCases(cwd).length;
      const deferCount = activeDeferItems(cwd).length;
      dispatch(buildGateResultEvent(decision, specCount, deferCount));
    },
    [cwd],
  );

  const handleEngineMessage = useCallback(
    (msg: Parameters<NonNullable<Parameters<typeof createEngineSession>[0]["onMessage"]>>[0]) => {
      // ST3(0.9.4 T2) — stream_event 델타를 동적 영역에 스로틀 렌더(진행 중 표시 전용).
      const accum = deltaAssemblerRef.current.apply(
        msg as unknown as { type?: string; event?: { type?: string; index?: number; content_block?: { type?: string }; delta?: { type?: string; text?: string } } },
      );
      if (accum !== null) scheduleStreamDelta(accum);

      for (const ev of mapEngineMessageToTuiEvents(msg)) dispatch(ev);
      for (const rec of mapSdkMessage(msg)) {
        if (!rec.text) continue;
        // ST15(0.9.2) — assistant 텍스트만 마크다운 경량 렌더(헤딩/코드펜스/diff 색상).
        // tool_use/tool_result/result는 원문 그대로(JSON·명령 출력이라 마크다운 파싱 대상 아님).
        if (rec.kind === "assistant") {
          // 최종(완성) assistant 텍스트가 도착한 시점 — 동적 영역(진행 중 델타)을 비우고 같은 텍스트를
          // 정적 스크롤백에 커밋한다. 순서가 중요하다(scope-critic ST3 지적): 비우기 전에 pushLine하면
          // 한 프레임 동안 같은 텍스트가 동적 영역+스크롤백에 동시에 보이는 이중출력 프레임이 생긴다.
          commitStream();
          for (const seg of formatMarkdownLite(rec.text)) pushLine(seg.text, seg.tone);
        } else {
          pushLine(rec.text, "dim");
        }
      }
    },
    [pushLine, scheduleStreamDelta, commitStream],
  );

  // ST1(0.9.4 T1) — 세션을 지연 생성하고 재사용한다. preToolUse/canUseTool/onMessage는 세션 생성
  // 시점에 한 번만 배선된다(EngineSession의 Options는 query() 1회 spawn에 고정 — buildEngineOptions
  // 설계 그대로 계승). cwd/model은 TUI 마운트 후 불변이라 세션 수명 내내 유효하다.
  const getOrCreateSession = useCallback(async (): Promise<EngineSession> => {
    if (sessionRef.current) return sessionRef.current;
    // GBC_CLAUDE_PATH(0.9.2 ST5) — cli.ts cmdRun과 동일 우회 seam(engine.ts claudeExecutablePath).
    const claudeExecutablePath = process.env.GBC_CLAUDE_PATH;
    const session = await createEngineSession({
      cwd,
      ...(model ? { model } : {}),
      ...(claudeExecutablePath ? { claudeExecutablePath } : {}),
      includePartialMessages: true,
      preToolUse: makeSdkPreToolUseHook(cwd, undefined, onGateDecision),
      canUseTool: makeInkCanUseTool(),
      onMessage: handleEngineMessage,
    });
    sessionRef.current = session;
    return session;
  }, [cwd, model, makeInkCanUseTool, onGateDecision, handleEngineMessage]);

  const submit = useCallback(
    async (prompt: string) => {
      pushLine(`❯ ${prompt}`, "code");
      dispatch({ type: "TURN_START" });
      const turnStartedAt = Date.now(); // ST15(0.9.2) — statusline lastTurnMs 계산용
      try {
        const session = await getOrCreateSession();
        const result = await session.submit(prompt);
        // EngineSession.submit()도 runEngine과 동일 계약(rethrow하지 않음, engine.ts) — 인증/네트워크
        // 실패·중단 어느 쪽도 반환값으로만 알 수 있다(0.9.1 실사용자 보고 교훈 승계).
        commitStream(); // 턴 종료 — 동적 영역에 델타 잔여가 남아있으면 정리(중단된 턴 방어)
        if (result.isError && result.error?.startsWith("SESSION_ENDED")) {
          // ST2(0.9.4) 감지 → 여기서 실제 복구: 죽은 세션을 버리고 다음 submit()이 새로 만들게 한다.
          sessionRef.current = null;
          pushLine("🐢 세션이 종료되어 다음 메시지부터 새 세션으로 다시 시작합니다.", "warn");
        } else {
          // 중단(aborted)은 사용자가 의도한 취소라 실패(danger)와 다른 톤(warn)으로 먼저 본다.
          const abortMsg = formatEngineAbort(result);
          if (abortMsg) {
            pushLine(abortMsg, "warn");
          } else {
            const failureMsg = formatEngineFailure(result);
            if (failureMsg) pushLine(failureMsg, "danger");
          }
        }
      } catch (e) {
        commitStream();
        // agent-sdk는 engine.ts가 lazy dynamic import한다(첫 프롬프트 제출 시점) — ink/react와 달리
        // cli.ts의 cmdTui try/catch는 이 실패를 못 잡는다(ST6 scope-critic 발견). 여기서 별도로
        // 친절 안내하지 않으면 사용자는 잘린 스택트레이스만 본다.
        const msg = String(e);
        if (/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(msg)) {
          pushLine(
            "🐢 A-mode 엔진(@anthropic-ai/claude-agent-sdk)이 설치되지 않았습니다. 설치: npm i @anthropic-ai/claude-agent-sdk",
            "danger",
          );
        } else {
          pushLine(`🐢 오류: ${msg.slice(0, 200)}`, "danger");
        }
      } finally {
        dispatch({ type: "TURN_END" });
        const g = detectGit(cwd);
        dispatch({
          type: "STATUSLINE_UPDATE",
          patch: { branch: g.branch, dirty: g.dirty, lastTurnMs: Date.now() - turnStartedAt },
        });
      }
    },
    [cwd, getOrCreateSession, pushLine, commitStream],
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
      if (state.streaming) void sessionRef.current?.interrupt();
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
    <Box flexDirection="column">
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
      {state.panel === "repos" && <ReposPanel cwd={cwd} />}
      {state.panel === "skills" && <SkillsPanel cwd={cwd} />}
      {/* ST5(0.9.4 T2) — Static 밖 동적 영역: partial 델타 진행 중 표시. 완성되면 commitStream()이
          streamingText를 비우는 동시에 같은 텍스트가 위 Static 스크롤백에 커밋된다(이중출력 방지). */}
      {state.streaming && !state.approval && state.streamingText && <Text>{state.streamingText}</Text>}
      {state.streaming && !state.approval && (
        <Text color="green">{formatSpinnerLine(spinnerTick, elapsedMs)}</Text>
      )}
      {state.approval ? (
        <ApprovalBox approval={state.approval} editing={approvalEditing} editText={Editor.getText(approvalEditor)} />
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
  );
}
