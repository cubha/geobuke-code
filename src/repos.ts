// 크로스-repo 레지스트리 — 등록된 repo들의 미해결 defer를 SessionStart에 환기(0.2.9).
// 글로벌(~/.gbc/repos.json)에 저장한다 — 크로스프로젝트라 project .gbc/가 아니라 홈.
// (~/.gbc/api-key·~/.gbc/version-check.json과 동위. gbcDir(homedir())가 ~/.gbc를 보장.)
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gbcDir, readJson, writeJson } from "./store.js";

function reposPath(): string {
  return join(gbcDir(homedir()), "repos.json");
}

/** 등록된 repo 절대경로 목록(없으면 []). */
export function loadRepos(): string[] {
  return readJson<string[]>(reposPath(), []);
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
