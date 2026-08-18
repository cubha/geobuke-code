// eval 회귀 케이스의 **적용이력 입력 조립 seam** (F-1 후속, 2026-08-13).
//
// 왜 별도 모듈인가 — regression.ts는 top-level await로 즉시 실행되는 스크립트라 테스트가 import할
// 수 없다. 조립을 그쪽에 인라인하면 "eval이 judge에 싣는 문자열"을 기계가 검사할 방법이 없어져
// F-1이 그대로 재발한다(test/eval-cases.test.mjs가 이 모듈을 import해 바이트 동일성을 락한다).
//
// 규율: cases.json은 **조립된 문자열을 적지 않는다.** 프로덕션 PostToolUse hook이 받는 것과 같은
// raw 편집 입력(tool·file·new_string)만 선언하고, 조립은 프로덕션 함수 자신
// (buildAppliedEntry → formatAppliedContext)이 한다. 이래야 케이스 입력이 "프로덕션이 낼 수 있는
// 형상"임이 **구조적으로 보장**된다 — 손으로 쓰면 요약형 같은 도달 불가능한 형상이 섞여 들어와
// green이 거짓안심이 된다(F-1 실측: 요약형 pass 3/3 vs 프로덕션형 block 3/3).
import { sep } from "node:path";
import { buildAppliedEntry, formatAppliedContext, selectAppliedForJudge, verifyAppliedEntry } from "../applied.js";
import type { AppliedEntry } from "../types.js";

/**
 * 케이스의 상대경로를 정규화 대상으로 만들기 위한 합성 프로젝트 루트. 실 디스크를 건드리지
 * 않는다 — normalizeAppliedFile은 어휘 비교만 하고 realpath를 해소하지 않는다(applied.ts 참조).
 */
export const EVAL_APPLIED_ROOT = "/repo";

/**
 * 합성 절대경로. `join()`이 아니라 **플랫폼 `sep`을 직접** 끼운다 — join은 win32에서 앞쪽
 * 구분자까지 `\`로 바꿔(`\repo\src\…`) `filePath.startsWith(cwd + sep)` 접두 비교가 깨지고
 * basename 폴백으로 떨어져 케이스 경로가 플랫폼마다 달라진다. `sep`을 끼우면 양쪽 다
 * "cwd 상대경로" 분기로 들어가 결과가 동일하다.
 */
export function evalAbsPath(file: string): string {
  return `${EVAL_APPLIED_ROOT}${sep}${file}`;
}

/** cases.json이 선언하는 raw 편집 입력(프로덕션 hook이 tool_input으로 받는 것과 같은 모양). */
export interface EvalAppliedEdit {
  /** 게이트 대상 도구. 생략 시 Edit. */
  tool?: string;
  /** EVAL_APPLIED_ROOT 기준 상대경로. */
  file: string;
  /** Edit/MultiEdit이 넣는 새 내용. */
  new_string?: string;
  /** Write가 넣는 전체 내용. */
  content?: string;
}

/** raw 편집 입력들을 프로덕션 엔트리로 변환(기록 불가 입력은 탈락 — 테스트가 그걸 금지한다). */
export function buildEvalAppliedEntries(edits: EvalAppliedEdit[]): AppliedEntry[] {
  return edits
    .map((e, i) =>
      buildAppliedEntry(
        e.tool ?? "Edit",
        { file_path: evalAbsPath(e.file), new_string: e.new_string, content: e.content },
        EVAL_APPLIED_ROOT,
        `2026-01-01T00:0${i}:00.000Z`,
      ),
    )
    .filter((e): e is AppliedEntry => e !== null);
}

/**
 * judge에 실을 `[이 작업단위에서 이미 적용된 편집]` 원문을 **프로덕션 조립 함수로** 만든다.
 * 편집이 없으면 undefined(섹션 자체 생략 — gate-core.ts와 동일 관례).
 *
 * `fileStates`(0.12.4 ST4) — 원장 생존 재검증(gate-core.ts evaluateGate와 동일 계약, `key`=
 * `EvalAppliedEdit.file`과 같은 상대경로·`value`=그 파일의 "현재 디스크 상태")을 eval에서
 * 재현한다. 선언 없는 파일은 `undefined`(=재검증 실패 취급, unverifiable) — "파일이 여전히
 * 그대로"라고 함부로 가정하면 stale 대칭쌍이 아무 근거 없이 alive로 새 green을 낼 수 있다.
 */
export function buildEvalAppliedContext(
  edits: EvalAppliedEdit[] | undefined,
  fileStates?: Record<string, string>,
): string | undefined {
  if (!edits || edits.length === 0) return undefined;
  const verify = (e: AppliedEntry) => verifyAppliedEntry(e, fileStates?.[e.file] ?? null);
  const selected = selectAppliedForJudge(buildEvalAppliedEntries(edits), { verify });
  return formatAppliedContext(selected).text || undefined;
}
