// 시각 유틸 단일 소스(0.6.1 F2) — nowIso ×5·nowStamp ×2 파일별 사본을 통합.
// Date 불가/실패 환경 방어 폴백 규약 포함(이벤트 at 필드=""·파일명 스탬프="nodate").

/** ISO 시각. 실패 시 ""(events.jsonl 등 at 필드 규약 — 파서가 빈 값 허용). */
export function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

/** 파일명 안전 타임스탬프(ISO의 ':' '.'을 '-'로). 실패 시 "nodate". */
export function nowStamp(): string {
  try {
    return new Date().toISOString().replace(/[:.]/g, "-");
  } catch {
    return "nodate";
  }
}
