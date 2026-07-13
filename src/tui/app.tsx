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
  selectMascot,
  renderMascot,
  formatGateLine,
  formatStatusline,
  formatSpinnerLine,
  formatMarkdownLite,
  WORDMARK_GEOBUKE,
  formatWelcomeCard,
  SPLASH_WIDE_MIN_COLUMNS,
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
} from "./bridge.js";
import { runEngine, mapSdkMessage } from "../engine.js";
import { makeSdkPreToolUseHook } from "../gate-sdk.js";
import { readSpecCases } from "../spec.js";
import { activeDeferItems, addDefer } from "../defer.js";
import { Segments } from "./ui/Segments.js";
import { Mascot } from "./ui/Mascot.js";
import { ApprovalBox } from "./ui/ApprovalBox.js";
import { MetricsPanel } from "./ui/MetricsPanel.js";
import { ReposPanel } from "./ui/ReposPanel.js";
import { SkillsPanel } from "./ui/SkillsPanel.js";
import { toneColor } from "./ui/theme.js";

type ScrollEntry =
  | { id: number; kind: "mascot"; lines: string[] }
  | { id: number; kind: "text"; text: string; tone: Tone }
  // ST13-14(0.9.2) — formatWelcomeCard가 한 줄에 여러 톤을 섞을 수 있는 TextSegment[][]를 반환하는데,
  // "text" variant(단일 tone)로 욱여넣으면 조용히 정보가 손실된다(scope-critic 발견, 2026-07-13
  // ST13-14 판정 DECISION_CHANGED:yes). 기존 <Segments> 렌더 관례(formatGateLine/formatStatusline과
  // 동일)를 그대로 재사용해 세그먼트별 톤을 보존한다.
  | { id: number; kind: "segments"; segments: TextSegment[] };

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

export function App({ cwd, model }: { cwd: string; model?: string }) {
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
  // ST3(0.9.2) — 현재 스트리밍 턴의 AbortController. submit()이 매 턴 새로 만들어 채우고 finally에서
  // 비운다(턴 종료 후 남은 참조로 다음 턴을 오작동 중단시키지 않도록).
  const abortControllerRef = useRef<AbortController | null>(null);
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

  // 스플래시 — 1회 커밋(Static, 워드마크+마스코트+안내카드 병치). ST13(format.ts)이 순수 포맷터를
  // 만들고 여기선 조립만 한다. 워드마크(59열 고정폭 figlet)는 좁은 터미널에서 줄바꿈되며 깨지므로
  // format.ts의 SPLASH_WIDE_MIN_COLUMNS(마스코트 폴백과 동일한 단일 임계값)로 그 아래에서는
  // 생략한다(마스코트 C4 미니만 남음) — 예전엔 워드마크 자신의 폭(59)을 따로 써서 마스코트
  // 임계값(60)과 1칸 어긋났었다(scope-critic 발견, ST13-14 판정 DECISION_CHANGED:yes).
  useEffect(() => {
    const mascot = renderMascot(selectMascot(columns));
    const wordmarkEntries: ScrollEntry[] =
      columns >= SPLASH_WIDE_MIN_COLUMNS
        ? WORDMARK_GEOBUKE.map((line) => ({ id: nextId.current++, kind: "text" as const, text: line, tone: "accent" as const }))
        : [];
    // formatWelcomeCard는 한 줄에 여러 톤을 섞을 수 있는 TextSegment[][] — 기존 <Segments> 렌더
    // 관례를 그대로 써서 톤을 보존한다(단일 tone으로 뭉개던 이전 구현의 정보손실 수정).
    const cardEntries: ScrollEntry[] = formatWelcomeCard(readSpecCases(cwd).length, activeDeferItems(cwd).length).map(
      (segments) => ({ id: nextId.current++, kind: "segments" as const, segments }),
    );
    setScrollback((s) => [
      ...wordmarkEntries,
      { id: nextId.current++, kind: "mascot", lines: mascot },
      ...cardEntries,
      ...s,
    ]);
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

  const submit = useCallback(
    async (prompt: string) => {
      pushLine(`❯ ${prompt}`, "code");
      dispatch({ type: "TURN_START" });
      const turnStartedAt = Date.now(); // ST15(0.9.2) — statusline lastTurnMs 계산용
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const onDecision = (decision: GateDecision) => {
        const specCount = readSpecCases(cwd).length;
        const deferCount = activeDeferItems(cwd).length;
        dispatch(buildGateResultEvent(decision, specCount, deferCount));
      };
      // GBC_CLAUDE_PATH(0.9.2 ST5) — cli.ts cmdRun과 동일 우회 seam(engine.ts claudeExecutablePath).
      const claudeExecutablePath = process.env.GBC_CLAUDE_PATH;
      try {
        const result = await runEngine({
          prompt,
          cwd,
          ...(model ? { model } : {}),
          ...(claudeExecutablePath ? { claudeExecutablePath } : {}),
          preToolUse: makeSdkPreToolUseHook(cwd, undefined, onDecision),
          canUseTool: makeInkCanUseTool(),
          abortController: controller,
          onMessage: (msg) => {
            for (const ev of mapEngineMessageToTuiEvents(msg)) dispatch(ev);
            for (const rec of mapSdkMessage(msg)) {
              if (!rec.text) continue;
              // ST15(0.9.2) — assistant 텍스트만 마크다운 경량 렌더(헤딩/코드펜스/diff 색상).
              // tool_use/tool_result/result는 원문 그대로(JSON·명령 출력이라 마크다운 파싱 대상 아님).
              if (rec.kind === "assistant") {
                for (const seg of formatMarkdownLite(rec.text)) pushLine(seg.text, seg.tone);
              } else {
                pushLine(rec.text, "dim");
              }
            }
          },
        });
        // runEngine()은 계약상 절대 rethrow하지 않는다(engine.ts) — 인증/네트워크 실패·중단 어느
        // 쪽도 반환값으로만 알 수 있다. 버리면 화면에 아무 표시 없이 "무응답"이 된다(0.9.1 실사용자
        // 보고). 중단(aborted)은 사용자가 의도한 취소라 실패(danger)와 다른 톤(warn)으로 먼저 본다.
        const abortMsg = formatEngineAbort(result);
        if (abortMsg) {
          pushLine(abortMsg, "warn");
        } else {
          const failureMsg = formatEngineFailure(result);
          if (failureMsg) pushLine(failureMsg, "danger");
        }
      } catch (e) {
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
        abortControllerRef.current = null;
        dispatch({ type: "TURN_END" });
        const g = detectGit(cwd);
        dispatch({
          type: "STATUSLINE_UPDATE",
          patch: { branch: g.branch, dirty: g.dirty, lastTurnMs: Date.now() - turnStartedAt },
        });
      }
    },
    [cwd, model, makeInkCanUseTool, pushLine],
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
      // ST3(0.9.2) — 스트리밍 중일 때만 중단. 유휴 상태에서 Esc는 여전히 no-op(전역 종료 단축키
      // 아님 — Ctrl+C 2단 확인종료가 그 역할, ST9/ST10 별도 SubTask).
      if (state.streaming) abortControllerRef.current?.abort();
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
          entry.kind === "mascot" ? (
            <Mascot key={entry.id} lines={entry.lines} />
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
