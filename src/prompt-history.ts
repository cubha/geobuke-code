// ST3-2(0.11.0) — repoId → 프롬프트 히스토리(TUI 입력창 ↑↓) 세션간 영속. session-map.ts(repoId→
// sessionId)와 동일 관례(store.ts gbcDir(homedir()) 크로스프로젝트 데이터 — repos.json/
// verify-run.json과 동위). 프롬프트 원문을 디스크에 남기는 것 자체가 시크릿 유입 표면이라
// extraction.ts redactSecrets를 저장 직전에 반드시 거친다. GBC_NO_PROMPT_HISTORY=1로 전체를 끈다
// (이 경우 append/load 둘 다 완전 no-op — 파일에 아예 아무것도 남기지 않는다).
import { homedir } from "node:os";
import { join } from "node:path";
import { gbcDirPath, ensureGbcDir, readJsonObject, writeJson, withStoreLock } from "./store.js";
import { redactSecrets } from "./extraction.js";

export interface PromptHistoryOpts {
  homeDir?: string;
}

const MAX_ENTRIES_PER_REPO = 100;

function promptHistoryPath(opts: PromptHistoryOpts): string {
  return join(gbcDirPath(opts.homeDir ?? homedir()), "prompt-history.json");
}

export function isPromptHistoryDisabled(): boolean {
  return process.env.GBC_NO_PROMPT_HISTORY === "1";
}

/** session-map.ts readMap과 동일 방어 관례 — 다른 프로세스가 쓰는 글로벌 파일이라 내용을 무조건
 * 신뢰하지 않는다. non-object(배열 등)는 빈 맵, 값이 배열이 아니거나 배열 원소가 문자열이 아니면
 * 필터링. */
function readMap(opts: PromptHistoryOpts): Record<string, string[]> {
  const raw = readJsonObject<Record<string, unknown>>(promptHistoryPath(opts), {});
  const out: Record<string, string[]> = {};
  for (const [repoId, list] of Object.entries(raw)) {
    if (Array.isArray(list)) out[repoId] = list.filter((x): x is string => typeof x === "string");
  }
  return out;
}

export function loadPromptHistory(repoId: string, opts: PromptHistoryOpts = {}): string[] {
  if (isPromptHistoryDisabled()) return [];
  return readMap(opts)[repoId] ?? [];
}

/** withStoreLock(session-map.ts와 동일 이유) — CLI 단발 호출과 TUI 장수 프로세스가 동시에 이 파일을
 * 고칠 수 있어 temp+rename 단독으론 lost-update를 막지 못한다. 연속 중복은 추가하지 않는다(editor.ts
 * commitSubmit의 히스토리 dedup 규약과 대칭 — 같은 텍스트가 히스토리에 반복 적재되지 않게). */
export function appendPromptHistory(repoId: string, text: string, opts: PromptHistoryOpts = {}): void {
  if (isPromptHistoryDisabled()) return;
  ensureGbcDir(opts.homeDir ?? homedir()); // withStoreLock의 lockDir mkdir이 디렉토리 존재를 전제(0.12.2)
  withStoreLock(promptHistoryPath(opts), () => {
    const map = readMap(opts);
    const existing = map[repoId] ?? [];
    const redacted = redactSecrets(text);
    const last = existing[existing.length - 1];
    const next = redacted === last ? existing : [...existing, redacted];
    map[repoId] = next.slice(-MAX_ENTRIES_PER_REPO);
    // security-auditor 지적(ST3-2) — 이 파일은 사용자가 자유형식으로 타이핑한 프롬프트 원문(redact
    // 후에도 완전 무해를 보장 못함, extraction.ts redactSecrets 자체가 "알려진 고신뢰 패턴만" 좁게
    // 마스킹한다고 명시)을 담아, repos.json 등 다른 .gbc 하위 파일보다 민감도가 훨씬 높다. 0o600으로
    // 다른 로컬 사용자의 읽기를 차단한다(다중 사용자 시스템·공유 워크스테이션 대비).
    writeJson(promptHistoryPath(opts), map, { mode: 0o600 });
  });
}
