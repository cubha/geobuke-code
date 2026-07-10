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
  const git = detectGit(cwd);
  const [state, dispatch] = useReducer(reduce, undefined, () => ({
    ...createInitialState({ dir: cwd, branch: git.branch, dirty: git.dirty, model: model ?? "" }),
    // createInitialState는 spec/defer 카운트를 모르는 순수함수라 0으로 시작한다 — 마운트 시점에
    // 실제 값으로 시드해야 스플래시 문구("spec 8케이스")와 게이트 줄("spec 0케이스")이 어긋나지
    // 않는다(스모크 테스트로 발견·수정).
    specCount: readSpecCases(cwd).length,
    deferCount: activeDeferItems(cwd).length,
  }));
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

  const pendingApproval = useRef<((a: { choice: ApprovalChoice; editedText?: string }) => void) | null>(null);

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
      if (!stateRef.current.approval) {
        dispatch({ type: "APPROVAL_REQUESTED", reason: options.decisionReason ?? "", kind: ctx.kind });
      }
      // spec-add는 Bash 명령 문자열에서 이미 케이스 텍스트를 동기 추출해뒀다(classifyApprovalRequest) —
      // "도출 중" 스피너는 실제로는 그 이전(에이전트 자신의 텍스트 응답, scrollback에 이미 출력됨)
      // 단계였을 뿐이라, 여기선 즉시 확정해 ApprovalBox가 "gbc spec add \"...\"" 문구를 그릴 수 있게 한다.
      // (자체검토로 발견: 이 dispatch가 빠져 derivedCase가 세션 내내 null로 고정되던 결함 수정.)
      if (ctx.kind === "spec-add") {
        dispatch({ type: "APPROVAL_CASE_DERIVED", caseText: ctx.derivedCase });
      }
      const answer = await new Promise<{ choice: ApprovalChoice; editedText?: string }>((resolve) => {
        pendingApproval.current = resolve;
      });
      const resolution = resolveApproval(answer.choice, ctx, input as Record<string, unknown>, answer.editedText);
      dispatch({ type: "APPROVAL_ANSWERED", choice: answer.choice });
      if (resolution.deferText) {
        try {
          addDefer(cwd, resolution.deferText);
        } catch {
          // 로컬 TUI 편의기능 — 실패해도 canUseTool 응답(deny)은 이미 확정돼 있어 엔진 흐름은 계속됨.
        }
      }
      return resolution.result;
    };
  }, [cwd]);

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
        await runEngine({
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
      } catch (e) {
        pushLine(`🐢 오류: ${String(e).slice(0, 200)}`, "danger");
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
      if (approvalEditing) {
        if (key.return) {
          const text = Editor.getText(approvalEditor);
          setApprovalEditing(false);
          pendingApproval.current?.({ choice: "e", editedText: text });
          pendingApproval.current = null;
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
        const choice = input as ApprovalChoice;
        dispatch({ type: "APPROVAL_ANSWERED", choice });
        pendingApproval.current?.({ choice });
        pendingApproval.current = null;
        return;
      }
      if (input === "e") {
        setApprovalEditor(Editor.insertText(Editor.createInitialState(), state.approval.derivedCase ?? ""));
        setApprovalEditing(true);
        return;
      }
      if (key.leftArrow) dispatch({ type: "APPROVAL_SELECTION_MOVE", direction: -1 });
      if (key.rightArrow) dispatch({ type: "APPROVAL_SELECTION_MOVE", direction: 1 });
      if (key.return) {
        const choice = state.approval.selection;
        if (choice === "e") {
          setApprovalEditor(Editor.insertText(Editor.createInitialState(), state.approval.derivedCase ?? ""));
          setApprovalEditing(true);
          return;
        }
        dispatch({ type: "APPROVAL_ANSWERED", choice });
        pendingApproval.current?.({ choice });
        pendingApproval.current = null;
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
