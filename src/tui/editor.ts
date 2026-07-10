// 0.9.0 A3a ST2 — 멀티라인 입력 에디터 순수 텍스트버퍼.
// ink#676(멀티라인 입력 에디터 미해결)로 자체 구현하는 영역. 커서 이동·삽입·삭제·개행 +
// 입력 히스토리(↑↓ — 빈 입력창에서 진입, 진입 후엔 계속 히스토리 탐색·좌우/편집으로 이탈)를
// 렌더 비의존 순수 함수로 제공한다.

export interface EditorState {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  history: string[];
  historyIndex: number | null;
  historyDraft: string;
}

export function createInitialState(): EditorState {
  return { lines: [""], cursorRow: 0, cursorCol: 0, history: [], historyIndex: null, historyDraft: "" };
}

export function getText(state: EditorState): string {
  return state.lines.join("\n");
}

export function isEmpty(state: EditorState): boolean {
  return state.lines.length === 1 && state.lines[0] === "";
}

/** 커서 위치에 text(개행 포함 가능 — paste)를 삽입, 커서는 삽입 끝으로 이동. */
export function insertText(state: EditorState, text: string): EditorState {
  const { lines, cursorRow, cursorCol } = state;
  const line = lines[cursorRow];
  const before = line.slice(0, cursorCol);
  const after = line.slice(cursorCol);
  const inserted = text.split("\n");

  if (inserted.length === 1) {
    const newLine = before + inserted[0] + after;
    const newLines = [...lines];
    newLines[cursorRow] = newLine;
    return { ...state, lines: newLines, cursorCol: before.length + inserted[0].length };
  }

  const first = before + inserted[0];
  const last = inserted[inserted.length - 1] + after;
  const middle = inserted.slice(1, -1);
  const newLines = [
    ...lines.slice(0, cursorRow),
    first,
    ...middle,
    last,
    ...lines.slice(cursorRow + 1),
  ];
  return {
    ...state,
    lines: newLines,
    cursorRow: cursorRow + inserted.length - 1,
    cursorCol: inserted[inserted.length - 1].length,
  };
}

/** Shift+Enter — 커서 위치에서 줄 분할. */
export function newline(state: EditorState): EditorState {
  return insertText(state, "\n");
}

export function backspace(state: EditorState): EditorState {
  const { lines, cursorRow, cursorCol } = state;
  if (cursorCol > 0) {
    const line = lines[cursorRow];
    const newLine = line.slice(0, cursorCol - 1) + line.slice(cursorCol);
    const newLines = [...lines];
    newLines[cursorRow] = newLine;
    return { ...state, lines: newLines, cursorCol: cursorCol - 1 };
  }
  if (cursorRow > 0) {
    const prevLen = lines[cursorRow - 1].length;
    const merged = lines[cursorRow - 1] + lines[cursorRow];
    const newLines = [...lines.slice(0, cursorRow - 1), merged, ...lines.slice(cursorRow + 1)];
    return { ...state, lines: newLines, cursorRow: cursorRow - 1, cursorCol: prevLen };
  }
  return state;
}

export function deleteForward(state: EditorState): EditorState {
  const { lines, cursorRow, cursorCol } = state;
  const line = lines[cursorRow];
  if (cursorCol < line.length) {
    const newLine = line.slice(0, cursorCol) + line.slice(cursorCol + 1);
    const newLines = [...lines];
    newLines[cursorRow] = newLine;
    return { ...state, lines: newLines };
  }
  if (cursorRow < lines.length - 1) {
    const merged = line + lines[cursorRow + 1];
    const newLines = [...lines.slice(0, cursorRow), merged, ...lines.slice(cursorRow + 2)];
    return { ...state, lines: newLines };
  }
  return state;
}

export function moveCursorLeft(state: EditorState): EditorState {
  const { lines, cursorRow, cursorCol } = state;
  if (cursorCol > 0) return { ...state, cursorCol: cursorCol - 1 };
  if (cursorRow > 0) return { ...state, cursorRow: cursorRow - 1, cursorCol: lines[cursorRow - 1].length };
  return state;
}

export function moveCursorRight(state: EditorState): EditorState {
  const { lines, cursorRow, cursorCol } = state;
  if (cursorCol < lines[cursorRow].length) return { ...state, cursorCol: cursorCol + 1 };
  if (cursorRow < lines.length - 1) return { ...state, cursorRow: cursorRow + 1, cursorCol: 0 };
  return state;
}

export function moveCursorUp(state: EditorState): EditorState {
  const { lines, cursorRow, cursorCol } = state;
  if (cursorRow === 0) return state;
  const targetRow = cursorRow - 1;
  return { ...state, cursorRow: targetRow, cursorCol: Math.min(cursorCol, lines[targetRow].length) };
}

export function moveCursorDown(state: EditorState): EditorState {
  const { lines, cursorRow, cursorCol } = state;
  if (cursorRow === lines.length - 1) return state;
  const targetRow = cursorRow + 1;
  return { ...state, cursorRow: targetRow, cursorCol: Math.min(cursorCol, lines[targetRow].length) };
}

function historyPrev(state: EditorState): EditorState {
  if (state.history.length === 0) return state;
  if (state.historyIndex === null) {
    const idx = state.history.length - 1;
    const text = state.history[idx];
    return {
      ...state,
      lines: text.split("\n"),
      cursorRow: 0,
      cursorCol: 0,
      historyIndex: idx,
      historyDraft: getText(state),
    };
  }
  const idx = Math.max(0, state.historyIndex - 1);
  const text = state.history[idx];
  const rowsCol = text.split("\n");
  return { ...state, lines: rowsCol, cursorRow: rowsCol.length - 1, cursorCol: rowsCol[rowsCol.length - 1].length, historyIndex: idx };
}

function historyNext(state: EditorState): EditorState {
  if (state.historyIndex === null) return state;
  if (state.historyIndex < state.history.length - 1) {
    const idx = state.historyIndex + 1;
    const text = state.history[idx];
    const rowsCol = text.split("\n");
    return { ...state, lines: rowsCol, cursorRow: rowsCol.length - 1, cursorCol: rowsCol[rowsCol.length - 1].length, historyIndex: idx };
  }
  const draftLines = state.historyDraft.split("\n");
  return {
    ...state,
    lines: draftLines,
    cursorRow: draftLines.length - 1,
    cursorCol: draftLines[draftLines.length - 1].length,
    historyIndex: null,
    historyDraft: "",
  };
}

/** ↑ — 히스토리 탐색 중이거나 버퍼가 비어있으면 히스토리, 아니면 커서 이동. */
export function arrowUp(state: EditorState): EditorState {
  if (state.historyIndex !== null || isEmpty(state)) return historyPrev(state);
  return moveCursorUp(state);
}

/** ↓ — 히스토리 탐색 중이면 히스토리, 아니면 커서 이동(빈 버퍼면 no-op). */
export function arrowDown(state: EditorState): EditorState {
  if (state.historyIndex !== null) return historyNext(state);
  if (isEmpty(state)) return state;
  return moveCursorDown(state);
}

/** Enter — 공백뿐이면 no-op(text:null). 아니면 history push(연속 중복 제외) + 버퍼 초기화. */
export function commitSubmit(state: EditorState): { text: string | null; state: EditorState } {
  const text = getText(state);
  if (text.trim() === "") return { text: null, state };
  const last = state.history[state.history.length - 1];
  const history = text === last ? state.history : [...state.history, text];
  return { text, state: { ...createInitialState(), history } };
}
