// gbc init 설치 로직 (순수함수 — cli.ts main() 부작용 없이 단위테스트 가능).
// 키 주입은 셸 확장($HOME)으로 머신 독립적이게 한다(하드코딩 홈경로 금지).

interface HookCmd {
  type: string;
  command: string;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCmd[];
}
interface Settings {
  hooks?: Record<string, HookEntry[]>;
}

/**
 * PreToolUse hook 명령 생성.
 * useKey=true면 ANTHROPIC_API_KEY를 $HOME/.gbc/api-key에서 읽어 주입(빠른 haiku 경로).
 * 경로는 셸이 확장하는 $HOME을 써 머신 독립적이게 한다.
 */
export function buildPreCommand(cliPath: string, useKey: boolean): string {
  const base = `node "${cliPath}" hook pre-tool-use`;
  // STUB: useKey 미반영 — ST3 유효 RED 유도용
  return base;
}

/**
 * 이미 설치된 keyless PreToolUse hook command를 키 주입 버전으로 업그레이드.
 * settings를 제자리 수정하고, 업그레이드한 건수를 반환한다(멱등: 이미 키주입된 건 건너뜀).
 */
export function upgradeKeylessHooks(settings: Settings, cliPath: string, useKey: boolean): number {
  // STUB: 미구현 — ST3 유효 RED 유도용
  return 0;
}
