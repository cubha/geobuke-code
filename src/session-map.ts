// repoId → 마지막 session_id 영속(0.10.0 A3b ST7). TUI가 탭(repo)을 opt-out했다가 나중에 다시
// opt-in할 때, 혹은 TUI 자체를 재시작했을 때 resume 후보로 쓴다 — repos.json/verify-run.json과
// 동위(store.ts gbcDir(homedir()) 관례): 크로스프로젝트 데이터라 project .gbc/가 아니라 홈.
import { homedir } from "node:os";
import { join } from "node:path";
import { gbcDir, readJsonObject, writeJson, withStoreLock } from "./store.js";

export interface SessionMapOpts {
  homeDir?: string;
}

function sessionMapPath(opts: SessionMapOpts): string {
  return join(gbcDir(opts.homeDir ?? homedir()), "session-map.json");
}

/**
 * session-map.json 판독 — repos.json(W4)과 동일한 방어 관례: 다른 프로세스가 쓰는 글로벌 파일이라
 * 내용을 무조건 신뢰하지 않는다. non-object(배열 등)는 빈 맵, 값이 문자열이 아닌 항목은 필터링.
 */
function readMap(opts: SessionMapOpts): Record<string, string> {
  const raw = readJsonObject<Record<string, unknown>>(sessionMapPath(opts), {});
  const out: Record<string, string> = {};
  for (const [repoId, sessionId] of Object.entries(raw)) {
    if (typeof sessionId === "string") out[repoId] = sessionId;
  }
  return out;
}

export function getLastSessionId(repoId: string, opts: SessionMapOpts = {}): string | null {
  return readMap(opts)[repoId] ?? null;
}

// withStoreLock(0.10.0 A3b ST8): read(readMap)→modify→write를 락으로 감싼다 — CLI 단발 호출과 TUI
// 장수 프로세스가 동시에 이 파일을 고칠 수 있어(repos.ts addRepo와 동일 이유) temp+rename 단독으론
// lost-update(한쪽의 갱신이 다른 쪽 rename에 덮여 사라짐)를 막지 못한다.

export function setLastSessionId(repoId: string, sessionId: string, opts: SessionMapOpts = {}): void {
  withStoreLock(sessionMapPath(opts), () => {
    const map = readMap(opts);
    map[repoId] = sessionId;
    writeJson(sessionMapPath(opts), map);
  });
}

export function clearLastSessionId(repoId: string, opts: SessionMapOpts = {}): void {
  withStoreLock(sessionMapPath(opts), () => {
    const map = readMap(opts);
    if (!(repoId in map)) return;
    delete map[repoId];
    writeJson(sessionMapPath(opts), map);
  });
}
