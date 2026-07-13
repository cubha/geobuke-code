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
import { selectMascot, renderMascot, formatGateLine, formatStatusline, type Tone } from "./format.js";
import {
  mapEngineMessageToTuiEvents,
  buildGateResultEvent,
  classifyApprovalRequest,
  resolveApproval,
  formatEngineFailure,
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
import { toneColor } from "./ui/theme.js";

type ScrollEntry =
  | { id: number; kind: "mascot"; lines: string[] }
  | { id: number; kind: "text"; text: string; tone: Tone };

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

  // 스플래시 — 1회 커밋(Static, 마스코트+게이트 활성 고지).
  useEffect(() => {
    const mascot = renderMascot(selectMascot(columns));
    setScrollback((s) => [
      { id: nextId.current++, kind: "mascot", lines: mascot },
      {
        id: nextId.current++,
        kind: "text",
        text: `🐢 게이트 활성 — 명세 없는 구현은 차단됩니다 · spec ${readSpecCases(cwd).length}케이스 · defer ${activeDeferItems(cwd).length}`,
        tone: "accent",
      },
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
      const onDecision = (decision: GateDecision) => {
        const specCount = readSpecCases(cwd).length;
        const deferCount = activeDeferItems(cwd).length;
        dispatch(buildGateResultEvent(decision, specCount, deferCount));
      };
      try {
        const result = await runEngine({
          prompt,
          cwd,
          ...(model ? { model } : {}),
          preToolUse: makeSdkPreToolUseHook(cwd, undefined, onDecision),
          canUseTool: makeInkCanUseTool(),
          onMessage: (msg) => {
            for (const ev of mapEngineMessageToTuiEvents(msg)) dispatch(ev);
            for (const rec of mapSdkMessage(msg)) {
              if (rec.text) pushLine(rec.text, rec.kind === "assistant" ? "plain" : "dim");
            }
          },
        });
        // runEngine()은 계약상 절대 rethrow하지 않는다(engine.ts) — 인증/네트워크 실패는 여기서
        // 반환값으로만 알 수 있다. 버리면 화면에 아무 표시 없이 "무응답"이 된다(0.9.1 실사용자 보고).
        const failureMsg = formatEngineFailure(result);
        if (failureMsg) pushLine(failureMsg, "danger");
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
        dispatch({ type: "TURN_END" });
        const g = detectGit(cwd);
        dispatch({ type: "STATUSLINE_UPDATE", patch: { branch: g.branch, dirty: g.dirty } });
      }
    },
    [cwd, model, makeInkCanUseTool, pushLine],
  );

  useInput((input, key) => {
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
    if (state.panel !== "none") {
      if (key.escape) dispatch({ type: "CLOSE_PANEL" });
      return;
    }
    if (key.escape) return; // 스트리밍 중단(abort) seam은 이후 iteration — 엔진에 아직 배선 없음.
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
          ) : (
            <Text key={entry.id} color={toneColor(entry.tone)}>
              {entry.text}
            </Text>
          )
        }
      </Static>
      {state.panel === "metrics" && <MetricsPanel cwd={cwd} />}
      {state.panel === "repos" && <ReposPanel cwd={cwd} />}
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
