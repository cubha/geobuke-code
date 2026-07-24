// 크로스-repo 레지스트리 — 등록된 repo들의 미해결 defer를 SessionStart에 환기(0.2.9).
// 글로벌(~/.gbc/repos.json)에 저장한다 — 크로스프로젝트라 project .gbc/가 아니라 홈.
// (~/.gbc/api-key·~/.gbc/version-check.json과 동위. gbcDir(homedir())가 ~/.gbc를 보장.)
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { gbcDir, readJsonArray, readJsonObject, writeJson, withStoreLock } from "./store.js";

function reposPath(): string {
  return join(gbcDir(homedir()), "repos.json");
}

/**
 * 등록된 repo 절대경로 목록(없으면 []). repos.json은 다른 프로세스가 수정할 수 있는 글로벌 파일이라
 * 내용을 무조건 신뢰하지 않는다 — 비-문자열·비-절대경로 항목은 방어 필터한다(보안검토 W4). 절대경로만
 * 통과시켜, 깨진/악의적 항목이 cmdMetrics --all 등의 읽기 대상이 되는 걸 차단한다(symlink 가드와 다층).
 */
export function loadRepos(): string[] {
  // 배열 형상은 readJsonArray(0.6.1 R3 단일 소스), 항목 신뢰 필터(문자열·절대경로)는 여기 유지.
  return readJsonArray<unknown>(reposPath()).filter(
    (r): r is string => typeof r === "string" && isAbsolute(r),
  );
}

/**
 * repo 등록(절대경로 정규화·멱등 dedup). 반환=등록 후 전체 목록.
 * withStoreLock(0.10.0 A3b ST8): read(loadRepos)→modify→write 전체를 락으로 감싼다 — temp+rename
 * 단독으로는 이 read-modify-write 시퀀스 중간에 다른 프로세스(gbc CLI 단발 호출 vs TUI 장수 프로세스)가
 * 끼어들어 서로의 추가/삭제를 지우는 lost-update를 막지 못한다(scope-critic 지적).
 */
export function addRepo(path: string): string[] {
  const abs = resolve(path);
  return withStoreLock(reposPath(), () => {
    const repos = loadRepos();
    if (!repos.includes(abs)) {
      repos.push(abs);
      writeJson(reposPath(), repos);
    }
    return repos;
  });
}

/** repo 등록 해제(절대경로 정규화). 반환=해제 후 전체 목록. withStoreLock — addRepo와 동일 이유. */
export function removeRepo(path: string): string[] {
  const abs = resolve(path);
  return withStoreLock(reposPath(), () => {
    const repos = loadRepos();
    const next = repos.filter((r) => r !== abs);
    if (next.length !== repos.length) writeJson(reposPath(), next);
    return next;
  });
}

// ===== verify --run 홈 pin (0.6.0 ST-D) =====
// ⚠️ 보안 설계핵심(DESIGN-verify-run-2026-07-05 §4, advisor #1 Critical): --run이 실행할 명령의
// 저장 위치는 repo 밖 홈(~/.gbc/verify-run.json)이어야 한다 — repo 내부(.gbc/config.json)에 두면
// PR이 git add -f로 커밋해 와 gitignore를 우회하는 공급망 RCE 벡터가 된다. 홈은 PR이 쓸 수 없어
// 벡터가 구조적으로 소멸한다(repos.json 동위·미러). 절대 .gbc/config.json으로 옮기지 말 것.

function verifyRunPath(): string {
  return join(gbcDir(homedir()), "verify-run.json");
}

/** verify-run.json 판독 — non-object(null·배열 등) 내용은 빈 객체로 방어(크래시 방지, security-auditor Info). */
function readVerifyRunMap(): Record<string, unknown> {
  return readJsonObject<Record<string, unknown>>(verifyRunPath(), {});
}

/** repo별 고정(pin) 러너 명령 판독 — 없으면 null. 비-문자열 방어 필터(repos.json W4 미러). */
export function getVerifyRunPin(repoPath: string): string | null {
  const abs = resolve(repoPath);
  const cmd = readVerifyRunMap()[abs];
  return typeof cmd === "string" && cmd.trim() !== "" ? cmd : null;
}

/** repo별 러너 명령 pin 저장(덮어쓰기). withStoreLock — addRepo와 동일한 read-modify-write 보호. */
export function setVerifyRunPin(repoPath: string, cmd: string): void {
  const abs = resolve(repoPath);
  withStoreLock(verifyRunPath(), () => {
    const raw = readVerifyRunMap();
    raw[abs] = cmd;
    writeJson(verifyRunPath(), raw);
  });
}
