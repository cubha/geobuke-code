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
/**
 * 더블쿼트 컨텍스트용 이스케이프. 셸이 확장하거나 따옴표를 벗어나지 못하도록
 * `"` 백틱 `$` `\` 를 백슬래시 처리한다(settings.json 명령 인젝션 방지).
 */
function shDquote(s: string): string {
  return s.replace(/(["`$\\])/g, "\\$1");
}

export function buildPreCommand(cliPath: string, useKey: boolean): string {
  const base = `node "${shDquote(cliPath)}" hook pre-tool-use`;
  // $HOME·$(...)는 의도된 셸 확장이므로 이스케이프하지 않는다.
  return useKey ? `ANTHROPIC_API_KEY="$(cat "$HOME/.gbc/api-key")" ${base}` : base;
}

/**
 * 이미 설치된 keyless PreToolUse hook command를 키 주입 버전으로 업그레이드.
 * settings를 제자리 수정하고, 업그레이드한 건수를 반환한다(멱등: 이미 키주입된 건 건너뜀).
 */
export function upgradeKeylessHooks(settings: Settings, cliPath: string, useKey: boolean): number {
  if (!useKey) return 0;
  const target = buildPreCommand(cliPath, true);
  let upgraded = 0;
  for (const entry of settings.hooks?.PreToolUse ?? []) {
    for (const h of entry.hooks ?? []) {
      // pre-tool-use hook인데 아직 키 주입이 없으면(keyless) 교체
      if (h.command.includes("hook pre-tool-use") && !h.command.includes("ANTHROPIC_API_KEY")) {
        h.command = target;
        upgraded++;
      }
    }
  }
  return upgraded;
}
