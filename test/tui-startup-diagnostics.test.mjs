// 0.9.1 ST2 — gbc tui/run 시작 크래시 메시지 분류(순수). 회사 사내 프록시 레지스트리에서
// 실사용 재현된 3단계 크래시(미설치·버전불일치·React 인스턴스 중복)를 인식해 진단 안내를 낸다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTuiStartupError } from "../dist/tui/startup-diagnostics.js";

const VERSIONS = { ink: "7.1.0", react: "19.2.7", agentSdk: "0.3.202" };

test("미설치(Cannot find package): 설치 안내 + 정확한 pin 버전 인용", () => {
  const out = classifyTuiStartupError("Error: Cannot find package 'ink' imported from ...", VERSIONS);
  assert.match(out, /설치되지 않았습니다/);
  assert.match(out, /ink@7\.1\.0/);
  assert.match(out, /react@19\.2\.7/);
  assert.match(out, /@anthropic-ai\/claude-agent-sdk@0\.3\.202/);
});

test("미설치(ERR_MODULE_NOT_FOUND): 동일 분기", () => {
  const out = classifyTuiStartupError("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '@anthropic-ai/claude-agent-sdk'", VERSIONS);
  assert.match(out, /설치되지 않았습니다/);
});

test("버전불일치(SyntaxError export 없음): npm ls 진단 명령 + 재설치 명령 안내", () => {
  const out = classifyTuiStartupError(
    "SyntaxError: The requested module 'ink' does not provide an export named 'useWindowSize'",
    VERSIONS,
  );
  assert.match(out, /버전이 안 맞습니다|버전 불일치|버전이 다릅니다/);
  assert.match(out, /npm ls -g ink react @anthropic-ai\/claude-agent-sdk/);
  assert.match(out, /ink@7\.1\.0/);
});

test("React 인스턴스 중복(useReducer null): 진단+재설치 안내", () => {
  const out = classifyTuiStartupError(
    "TypeError: Cannot read properties of null (reading 'useReducer')",
    VERSIONS,
  );
  assert.match(out, /React.*(두 벌|중복|여러 개)/);
  assert.match(out, /npm ls -g react/);
});

test("React 인스턴스 중복: useState/useRef/useEffect/useContext 등 다른 훅 이름도 인식", () => {
  for (const hook of ["useState", "useRef", "useEffect", "useContext", "useCallback", "useMemo"]) {
    const out = classifyTuiStartupError(`TypeError: Cannot read properties of null (reading '${hook}')`, VERSIONS);
    assert.notEqual(out, null, `${hook} 패턴을 인식하지 못함`);
  }
});

test("무관한 null-property 에러는 오탐하지 않는다(훅 이름이 아니면 null 반환)", () => {
  const out = classifyTuiStartupError("TypeError: Cannot read properties of null (reading 'foo')", VERSIONS);
  assert.equal(out, null, "훅 이름이 아닌 임의 프로퍼티 에러를 React 중복으로 오분류함");
});

test("분류 대상 아닌 에러는 null(원본 에러 그대로 노출 계약)", () => {
  assert.equal(classifyTuiStartupError("Error: ENOENT: no such file or directory", VERSIONS), null);
  assert.equal(classifyTuiStartupError("", VERSIONS), null);
});

test("순수함수 — 같은 입력엔 항상 같은 출력(결정론)", () => {
  const msg = "SyntaxError: The requested module 'ink' does not provide an export named 'useWindowSize'";
  assert.equal(classifyTuiStartupError(msg, VERSIONS), classifyTuiStartupError(msg, VERSIONS));
});
