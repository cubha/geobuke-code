// 크로스-repo 레지스트리 — 등록된 repo들의 미해결 defer를 SessionStart에 환기(0.2.9).
// 글로벌(~/.gbc/repos.json)에 저장한다 — 크로스프로젝트라 project .gbc/가 아니라 홈.
// (~/.gbc/api-key·~/.gbc/version-check.json과 동위. gbcDir(homedir())가 ~/.gbc를 보장.)
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { gbcDir, readJson, writeJson } from "./store.js";

function reposPath(): string {
  return join(gbcDir(homedir()), "repos.json");
}

/**
 * 등록된 repo 절대경로 목록(없으면 []). repos.json은 다른 프로세스가 수정할 수 있는 글로벌 파일이라
 * 내용을 무조건 신뢰하지 않는다 — 비-문자열·비-절대경로 항목은 방어 필터한다(보안검토 W4). 절대경로만
 * 통과시켜, 깨진/악의적 항목이 cmdMetrics --all 등의 읽기 대상이 되는 걸 차단한다(symlink 가드와 다층).
 */
export function loadRepos(): string[] {
  const raw = readJson<unknown>(reposPath(), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === "string" && isAbsolute(r));
}

/** repo 등록(절대경로 정규화·멱등 dedup). 반환=등록 후 전체 목록. */
export function addRepo(path: string): string[] {
  const abs = resolve(path);
  const repos = loadRepos();
  if (!repos.includes(abs)) {
    repos.push(abs);
    writeJson(reposPath(), repos);
  }
  return repos;
}

/** repo 등록 해제(절대경로 정규화). 반환=해제 후 전체 목록. */
export function removeRepo(path: string): string[] {
  const abs = resolve(path);
  const repos = loadRepos();
  const next = repos.filter((r) => r !== abs);
  if (next.length !== repos.length) writeJson(reposPath(), next);
  return next;
}
