// 작업단위 구현이력 부재 근본수정(0.12.3 P2a). 게이트가 매 편집을 백지 재평가하던 근본원인은
// gbc엔 PostToolUse가 없어 "방금 그 편집이 실제로 적용됐다"는 사실 자체를 알 방법이 없었던 것
// (RCA: 동일 케이스 03:02→03:17→03:17→03:23 4회 재차단, 그 사이 모델은 순차 구현 중이었음).
// 이 파일은 순수 부품 + .gbc/applied.json 원장 I/O만 담는다 — judge 프롬프트 배선(SubTask2)·
// gate-core 배선(SubTask3)은 다루지 않는다(evidence.ts와 동일한 관심사 분리).
//
// ⚠️ gate-core.ts를 import하지 않는다(단방향 — evidence.ts 헤더 규율과 동일). gate-core.ts가 이
// 파일의 loadApplied를 가져다 쓰므로(SubTask3), 반대 방향 import는 순환을 만든다. isDocFile 같은
// gate-core.ts 전용 판별은 이 파일의 책임이 아니다 — 필요하면 호출부(hook.ts)가 조합한다.
import { existsSync, unlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { gbcDirPath, ensureGbcDir, withStoreLock, readJsonObject, writeJson, basenameOf } from "./store.js";
import { redactSecrets } from "./extraction.js";
import { isGatedTool, isOverwriteEdit } from "./normalize.js";
import type { EditToolInput, AppliedEntry, AppliedLedger } from "./types.js";

/** 작업단위당 보관하는 최대 엔트리 수(FIFO, 오래된 것부터 탈락) — 프롬프트 총량과 원장 크기 상한. */
export const MAX_APPLIED_ENTRIES = 20;

/** 엔트리 1건의 새 내용 요약 상한(문자) — normalize.ts clip()과 동일 절단 관례. */
export const MAX_APPLIED_DIGEST = 400;

/**
 * judge 프롬프트에 실리는 적용이력 섹션 **총량** 상한(evidence.ts MAX_EVIDENCE_CONTEXT_CHARS와
 * 동형 이유 — 근거는 재판정의 존재 이유이므로 파일 상태보다 작아선 안 되고 압도해서도 안 된다).
 * 8000(MAX_CURRENT_FILE)+8000(MAX_FIELD)+evidenceContext(최대 8000) 예산에 얹는 신규 증분이라
 * 0.12.1이 이미 올려둔 CLI/API 타임아웃(45s) 안에서 판단한다(judge.ts 참조).
 */
export const MAX_APPLIED_CONTEXT_CHARS = 3000;

function appliedPath(cwd: string): string {
  return join(gbcDirPath(cwd), "applied.json");
}

/**
 * 원장 판독 — readJsonObject의 제네릭 제약(Record<string, unknown>)에 named interface가 직접
 * 안 맞아(repos.ts readVerifyRunMap과 동일 관례) Record로 받은 뒤 필드별로 방어 캐스팅한다
 * (다른 프로세스가 쓰는 글로벌 파일이라 형상을 무조건 신뢰하지 않는다는 W4 관례).
 */
function readLedger(cwd: string): AppliedLedger {
  const raw = readJsonObject<Record<string, unknown>>(appliedPath(cwd), {});
  return {
    specHash: typeof raw.specHash === "string" ? raw.specHash : "",
    entries: Array.isArray(raw.entries) ? (raw.entries as AppliedEntry[]) : [],
  };
}

/**
 * cwd 기준 상대경로로 정규화 — 밖이면 basename만(0.12.2 store.ts 관례와 동일하게 어휘 비교,
 * realpath 해소는 하지 않는다 — 이 값은 매칭 키가 아니라 judge 프롬프트에 실리는 표시용 라벨이라
 * evidence.ts relKey처럼 grep 결과와 대조할 필요가 없다). buildAppliedEntry·selectAppliedForJudge가
 * 같은 정규화를 공유해야 Write self-file 필터(아래)가 정확히 매칭된다.
 */
export function normalizeAppliedFile(cwd: string, filePath: string): string {
  if (filePath === cwd || filePath.startsWith(cwd + sep)) return filePath.slice(cwd.length + 1);
  return basenameOf(filePath);
}

/**
 * 이번 편집이 적용한 **새 내용만** 요약한다(순수) — old_string은 담지 않는다: 원장의 질문은
 * "지금 무엇이 구현돼 있나"이지 "무엇이 지워졌나"가 아니다(normalizeEdit의 diff 형태와 다른 이유).
 * redactSecrets를 여기(기록 시점) 1곳에서만 거친다 — at-rest(.gbc/applied.json 영속)·전송(judge
 * 프롬프트) 양쪽이 같은 마스킹된 값을 재사용해 노출면 분석 지점을 단일화한다(0.12.0 ship 교훈:
 * "전송 vs 디스크 영속은 노출면이 다르다" — 저장 이후 재마스킹하지 않아도 되게 소스를 미리 정제).
 */
export function summarizeAppliedEdit(toolName: string, input: EditToolInput): string {
  let text: string;
  if (isOverwriteEdit(toolName, input)) {
    text = input.content ?? "";
  } else if (toolName === "MultiEdit" || Array.isArray(input.edits)) {
    text = (input.edits ?? []).map((e) => e.new_string ?? "").join("\n");
  } else {
    text = input.new_string ?? "";
  }
  if (!text) return "";
  const redacted = redactSecrets(text);
  return redacted.length > MAX_APPLIED_DIGEST ? redacted.slice(0, MAX_APPLIED_DIGEST) + "\n…(절단됨)" : redacted;
}

/**
 * `tool_response`가 **실패를 명시**하는가(순수, 0.12.3 ship 보안검토 S6).
 *
 * PostToolUse가 "성공한 편집에만 발화한다"는 것은 hook 계약에 대한 *가정*일 뿐 코드가 검증하던
 * 바가 아니었다 — Edit의 old_string 매칭 실패로 도구가 에러를 반환해도 우리는 tool_input의
 * new_string만 보고 "적용됨"으로 기록했고, 디스크에 없는 코드가 "완료된 사실"로 judge에 제출되면
 * 실제 누락이 통과한다(미탐).
 *
 * ⚠️ 판정 방향: **실패 신호가 있을 때만 버린다**(성공 신호가 있을 때만 기록, 이 아니다).
 * 후자로 하면 tool_response 형상이 조금만 달라져도 P2a가 통째로 무동작이 되어 애초 고치려던 RCA
 * 결함으로 되돌아간다 — 새 가드의 오작동이 기존 기능을 죽이면 안 된다는 fail-open 관례와 동형.
 * 그래서 필드가 없거나 형상을 모르면 기록한다(보수적인 쪽은 "덜 기록"이 아니라 "덜 단정"이다).
 */
export function isAppliedFailure(toolResponse: unknown): boolean {
  if (typeof toolResponse !== "object" || toolResponse === null) return false;
  const r = toolResponse as Record<string, unknown>;
  if (r.success === false) return true;
  if (r.is_error === true) return true;
  // 빈 문자열 error는 실패 신호가 아니다(형상만 있고 내용이 없는 응답 흡수).
  if (typeof r.error === "string" && r.error.trim() !== "") return true;
  if (r.error !== undefined && typeof r.error !== "string" && r.error !== null && r.error !== false) return true;
  return false;
}

/**
 * PostToolUse 입력에서 원장 엔트리를 만든다(순수). 기록 대상이 아니면 null:
 * - 게이트 대상 도구(Edit/Write/MultiEdit)가 아님
 * - file_path 없음
 * - 새 내용이 빈 편집(순수 삭제) — "적용된 구현"이 없으므로 기록할 이유가 없다
 *
 * isDocFile(gate-core.ts) 필터는 의도적으로 여기 없다 — 그 판별을 쓰려면 gate-core.ts를 import해야
 * 하는데, gate-core.ts가 이 파일의 loadApplied를 가져다 쓰므로(SubTask3) 순환 참조가 된다. 문서
 * 편집을 원장에서 빼고 싶으면 호출부(hook.ts)가 gate-core.ts의 isDocFile과 조합한다.
 */
export function buildAppliedEntry(
  toolName: string,
  input: EditToolInput,
  cwd: string,
  at: string,
): AppliedEntry | null {
  if (!isGatedTool(toolName)) return null;
  const filePath = input.file_path;
  if (!filePath) return null;
  const digest = summarizeAppliedEdit(toolName, input);
  if (!digest) return null;
  return { at, tool: toolName, file: normalizeAppliedFile(cwd, filePath), digest };
}

/**
 * 작업단위(specHash) 스코프의 원장을 읽는다. 빈 명세("")는 절대 조회하지 않는다 — 빈-spec 상수
 * 해시가 원장을 교차 작업단위로 오염시키는 경로를 원천 차단(gate-core.ts 캐시 가드와 동일 판례).
 * 저장된 원장의 specHash가 요청 specHash와 다르면(작업단위 전환) 빈 배열 — 자동 무효화.
 */
export function loadApplied(cwd: string, specHash: string): AppliedEntry[] {
  if (specHash === "") return [];
  const ledger = readLedger(cwd);
  if (ledger.specHash !== specHash) return [];
  return ledger.entries;
}

/**
 * 엔트리 1건을 원장에 추가한다(I/O, 락으로 감쌈 — repos.json 등과 동일한 read-modify-write 경합
 * 방지 관례). specHash가 저장된 원장과 다르면 원장을 새로 시작한다(이전 작업단위 엔트리 폐기) —
 * 해시 변경을 넘겨 이월하면 `gbc done`이 존재하는 이유인 "옛 케이스 부활" 드리프트가 다른 이름으로
 * 재현된다(defer-spec 드리프트 근본수정과 동일 원칙). 빈 명세("")는 절대 기록하지 않는다.
 * FIFO 상한(MAX_APPLIED_ENTRIES) — 초과분은 가장 오래된 것부터 버린다.
 */
export function recordApplied(cwd: string, specHash: string, entry: AppliedEntry): void {
  if (specHash === "") return;
  ensureGbcDir(cwd);
  const path = appliedPath(cwd);
  withStoreLock(path, () => {
    const existing = readLedger(cwd);
    const entries = existing.specHash === specHash ? existing.entries : [];
    const next = [...entries, entry].slice(-MAX_APPLIED_ENTRIES);
    const ledger: AppliedLedger = { specHash, entries: next };
    writeJson(path, ledger);
  });
}

/** 원장을 지운다(멱등) — `gbc done`(작업단위 명시 종료)이 호출한다. `gate reset`은 지우지 않는다. */
export function clearApplied(cwd: string): void {
  const path = appliedPath(cwd);
  if (existsSync(path)) unlinkSync(path);
}

/**
 * judge에 실을 엔트리를 고른다(순수) — Write(전체 덮어쓰기) self-file 필터. 덮어쓰기 대상과 같은
 * 파일의 과거 엔트리를 보여주면 GATE_SYSTEM ★★ 규칙(덮어쓰기로 삭제되는 회귀는 여전히 missing)과
 * 정면 충돌해 정답인 block을 pass로 논증하게 만든다 — P2b의 isOverwriteEdit 억제·F-8 삭제스코프와
 * 같은 계열의 가드다. overwriteFile 없으면(Edit/MultiEdit 경로) 전부 유지.
 */
export function selectAppliedForJudge(
  entries: AppliedEntry[],
  opts: { overwriteFile?: string },
): AppliedEntry[] {
  if (!opts.overwriteFile) return entries;
  return entries.filter((e) => e.file !== opts.overwriteFile);
}

/**
 * 엔트리들을 judge 프롬프트용 텍스트로 조립한다(순수, evidence.ts formatEvidenceContext와 동형
 * 예산 규율). 총량이 MAX_APPLIED_CONTEXT_CHARS를 넘으면 **최신순으로 배정**하고(결정적 엔트리는
 * 거의 항상 최근 1~2건 — 순차 구현이 재차단되는 시나리오이므로) 오래된 것부터 버린다. 표시는
 * 오래된→최신 순서로 되돌려 번호를 매기고, 실제 최신 엔트리에만 "(최신)" 표시를 붙인다. 첫(=가장
 * 최신) 엔트리 하나가 상한을 넘어도 그 1건은 통째로 담는다 — 근거가 0이면 섹션 자체가 무의미해진다.
 */
export function formatAppliedContext(entries: AppliedEntry[]): { text: string; dropped: number } {
  if (entries.length === 0) return { text: "", dropped: 0 };
  const newestFirst = [...entries].reverse();
  const kept: AppliedEntry[] = [];
  let total = 0;
  let dropped = 0;
  for (const e of newestFirst) {
    const line = `[${e.file}] ${e.digest}`;
    if (kept.length > 0 && total + line.length + 2 > MAX_APPLIED_CONTEXT_CHARS) {
      dropped++;
      continue;
    }
    kept.push(e);
    total += line.length + 2;
  }
  kept.reverse();
  const latest = entries[entries.length - 1];
  const lines = kept.map((e, i) => `${i + 1}. [${e.file}] ${e.digest}${e === latest ? " (최신)" : ""}`);
  const note = dropped > 0 ? `\n…(${dropped}건 생략)` : "";
  return { text: lines.join("\n") + note, dropped };
}
