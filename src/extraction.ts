// A-mode extraction sink (0.7.0 A1 ST2) — SDK query() 스트림에서 뽑은 레코드를 .gbc/extraction.jsonl에
// append한다. events.jsonl(metrics.ts, enum 태그만)과 *분리된* 1차 자산: 진짜 M1(post-gate 시나리오
// 위반율) 사후대조는 "모델이 실제로 무엇을 했나"를 필요로 하고, 그건 B-모드 hook 계측이 못 보는
// SDK 스트림에서만 나온다(0.8.0 A2가 extraction⨝events를 session_id로 조인).
// 정책(스키마 설계시점 확정, 마이그레이션 비용 회피):
//  · join key = session 단독(specHash 미포함 — A-mode는 작업단위 해시가 아니라 세션이 상관 축).
//  · 구조 필드(tool·file·decision·kind)는 enum/경로/id라 그대로. 자유텍스트(text)만 redact+캡.
//  · 사이즈 상한 초과 시 1세대 로테이션(.jsonl→.1.jsonl) — 무한 성장 차단, 최근분 보존.
import { appendFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { gbcDir } from "./store.js";

/** 한 줄 레코드 최대 바이트(events.jsonl과 동일 상한 — O_APPEND atomic 보장). */
export const MAX_LINE = 4096;
/** 자유텍스트 필드 캡(직렬화 전 선절단 — 라인 상한과 별개로 본문 폭주 방지). */
export const MAX_TEXT = 2000;
/** extraction.jsonl 파일 상한(바이트). 초과 시 .1로 로테이션. */
export const MAX_EXTRACTION_BYTES = 5 * 1024 * 1024;

/**
 * A-mode 추출 레코드(.gbc/extraction.jsonl 한 줄). session이 유일 조인키.
 * text는 redact+캡 대상(민감정보·본문 폭주 차단), 나머지는 구조 필드.
 */
export interface ExtractionRecord {
  /** ISO 타임스탬프 */
  at: string;
  /** session_id — events.jsonl과의 유일 조인키 */
  session: string;
  /** 레코드 종류(SDK 스트림 매핑) */
  kind: "tool_use" | "tool_result" | "assistant" | "gate" | "result";
  /** tool_use: 도구명(Edit/Write/Bash 등) */
  tool?: string;
  /** tool_use(파일 편집): 대상 경로(조인·churn 분석 축) */
  file?: string;
  /** gate: evaluateGate 판정(pass/block/…) */
  decision?: string;
  /** 자유텍스트(사유·요약·인자 스니펫) — redact+캡 대상. */
  text?: string;
}

const REDACTED = "[REDACTED]";

/**
 * 민감정보 redaction(순수) — 자유텍스트에서 고신뢰 시크릿 패턴만 좁게 마스킹한다.
 * 과다-redaction(일반 산문·경로 훼손)을 피하려 확정 패턴만: Anthropic/OpenAI 키, Bearer,
 * KEY/TOKEN/SECRET/PASSWORD 대입(키 이름은 남기고 값만). 조인·분석에 쓰는 구조 필드엔 적용 안 함.
 */
export function redactSecrets(_text: string): string {
  throw new Error("redactSecrets: not implemented (ST2 RED)");
}

/**
 * 레코드를 한 줄 JSON으로 직렬화(순수). text는 redact 후 MAX_TEXT로 캡하고, 그래도 라인이 MAX_LINE을
 * 넘으면 text를 요약 토큰으로 대체해 한 줄을 보장한다(events.jsonl serializeEvent 미러).
 */
export function serializeRecord(_rec: ExtractionRecord): string {
  throw new Error("serializeRecord: not implemented (ST2 RED)");
}

/**
 * jsonl 원시 텍스트를 레코드 배열로 파싱(빈 줄·깨진 줄 skip). session+kind 문자열이 있어야 레코드로 인정
 * (events.jsonl parseEvents 미러 — 형상 오염 흡수).
 */
export function parseExtraction(_raw: string): ExtractionRecord[] {
  throw new Error("parseExtraction: not implemented (ST2 RED)");
}

/** .gbc/extraction.jsonl 경로. */
export function extractionPath(cwd: string): string {
  return join(gbcDir(cwd), "extraction.jsonl");
}

/**
 * 현재 파일이 상한 이상이면 1세대 로테이션(.jsonl→.1.jsonl, 기존 .1은 덮어씀) 후 append. 파일 부재/stat
 * 실패는 로테이션 없이 append(최초 기록). GBC_NO_EXTRACTION=1이면 무동작(opt-out, metrics 규약 미러).
 * append/rotation 실패는 삼킨다(fail-silent — 계측이 A-mode 실행을 막지 않는다).
 * STUB(ST2 RED).
 */
export function appendExtraction(
  _cwd: string,
  _rec: ExtractionRecord,
  _opts: { maxBytes?: number } = {},
): void {
  throw new Error("appendExtraction: not implemented (ST2 RED)");
}
