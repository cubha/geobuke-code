// 0.9.1 ST2 — gbc tui/run 시작 크래시 메시지 분류(순수). 회사 사내 프록시 레지스트리
// (Nexus/Artifactory류)에서 실사용 재현된 3단계 연쇄 실패(2026-07-13, lxhausys 사내망)를
// 인식해 진단 안내를 낸다. 버전 문자열은 호출부(cli.ts)가 package.json에서 읽어 넘긴다 —
// 이 함수 안에 하드코딩하면 다음 릴리스에서 pin 버전이 바뀔 때 안내 문구가 drift한다.
//
// 세 패턴의 근거(실사용 스택트레이스, ST7 도그푸딩 중 확인):
// ①미설치 — Cannot find module/package, ERR_MODULE_NOT_FOUND(기존 cmdTui 분기 승계)
// ②버전불일치 — SyntaxError: 요청한 export가 없음(캐럿 range가 사내 레지스트리의 구버전과
//   dedup 충돌해 발생. 0.9.1에서 ink를 exact pin으로 바꿨지만 사용자가 이미 꼬인 전역
//   node_modules를 갖고 있을 수 있어 진단 안내는 계속 필요)
// ③React 인스턴스 중복 — 훅 디스패처가 null(패키지를 개별로 나눠 설치하면 peerDependency가
//   따로 깔려 두 벌이 됨). 훅 이름이 아닌 임의 null-property 에러까지 이걸로 오분류하면
//   안 되므로 알려진 훅 이름만 화이트리스트로 매칭한다.
export interface TuiDepsVersions {
  ink: string;
  react: string;
  agentSdk: string;
}

const NOT_INSTALLED_RE = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/;
// 모듈명 앵커 필수 — ink/react의 전이 의존성(yoga-layout·cli-cursor 등)에서 같은 문법의
// export-mismatch가 나면 앵커 없이는 "ink/react 재설치"라는 확정적이지만 틀린 처방을 낸다
// (scope-critic 발견).
const VERSION_MISMATCH_RE = /The requested module '(?:ink|react)' does not provide an export named/;
// useInsertionEffect 필수 — ink 자신의 루트 컴포넌트(App.js)가 모든 렌더에서 무조건 호출하는
// 훅이라, React 인스턴스 중복 크래시가 실제로 가장 흔히 첫 타격하는 지점이다(scope-critic이
// node_modules/ink/build/components/App.js:320·hooks/use-cursor.js:20 실증). useLayoutEffect·
// useSyncExternalStore·useId는 React 19 내부에서 흔히 쓰이는 훅이라 방어적으로 함께 넣는다.
const DUPLICATE_REACT_RE =
  /Cannot read propert(?:y|ies) of null[\s\S]*\buse(?:Reducer|State|Ref|Effect|Context|Callback|Memo|InsertionEffect|LayoutEffect|SyncExternalStore|Id)\b/;

function reinstallCmd(v: TuiDepsVersions): string {
  return `npm uninstall -g ink react @anthropic-ai/claude-agent-sdk && npm install -g ink@${v.ink} react@${v.react} @anthropic-ai/claude-agent-sdk@${v.agentSdk}`;
}

/**
 * gbc tui/run 시작 시(모듈 로드~초기 렌더) 발생한 에러 메시지를 분류해 사용자 안내 문구를
 * 반환한다. 분류 안 되면 null — 호출부는 원본 에러를 그대로 노출해야 한다(진단 실패를
 * 거짓 안내로 덮지 않음).
 */
export function classifyTuiStartupError(msg: string, versions: TuiDepsVersions): string | null {
  if (NOT_INSTALLED_RE.test(msg)) {
    return (
      "🐢 gbc tui 실행에 필요한 패키지가 설치되지 않았습니다.\n" +
      `   설치: npm i ink@${versions.ink} react@${versions.react} @anthropic-ai/claude-agent-sdk@${versions.agentSdk}`
    );
  }
  if (VERSION_MISMATCH_RE.test(msg)) {
    return (
      `🐢 설치된 ink/react 버전이 안 맞습니다(요구: ink@${versions.ink}). 사내 프록시 레지스트리에\n` +
      "   남아있던 다른 버전과 충돌했을 수 있습니다.\n" +
      "   확인: npm ls -g ink react @anthropic-ai/claude-agent-sdk\n" +
      `   재설치: ${reinstallCmd(versions)}`
    );
  }
  if (DUPLICATE_REACT_RE.test(msg)) {
    return (
      "🐢 React가 두 벌 이상 설치돼 훅이 깨졌습니다(패키지를 개별로 나눠 설치하면 흔히 발생).\n" +
      "   확인: npm ls -g react\n" +
      `   재설치: ${reinstallCmd(versions)}`
    );
  }
  return null;
}
