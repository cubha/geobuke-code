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
 * 민감정보 redaction(순수) — 자유텍스트에서 *알려진 고신뢰 패턴만* 좁게 마스킹한다.
 * ⚠️ 이것은 **패턴 기반 best-effort defense-in-depth이지 완전한 시크릿 스캐닝이 아니다.** 신규/사설
 * 토큰 형식은 놓칠 수 있다 — 최종 방어선은 .gbc/가 gitignore이고(커밋 유출 경로 없음) 로컬 파일 한정이며
 * GBC_NO_EXTRACTION=1로 전체를 끌 수 있다는 점이다. 과다-redaction(일반 산문·경로 훼손)을 피하려
 * 확정 패턴만 넣는다. 조인·분석에 쓰는 구조 필드(file 등)엔 적용하지 않는다(설계상 — 헤더 주석 참조).
 * 커버: Anthropic/OpenAI 키·AWS access key id·GitHub 토큰·Bearer/Basic·URL 임베디드 크리덴셜·
 * PEM 프라이빗 키 블록·KEY/TOKEN/SECRET/PASSWORD 대입.
 */
export function redactSecrets(text: string): string {
  return text
    // Anthropic 키(sk-ant-…) / 일반 sk-… 롱토큰
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, REDACTED)
    // AWS access key id
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    // GitHub 토큰(ghp_/gho_/ghu_/ghs_/ghr_)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, REDACTED)
    // PEM 프라이빗 키 블록(줄바꿈 포함 전체)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED)
    // Authorization 스킴(Bearer/Basic) 토큰 — 스킴 키워드는 보존, 값만 마스킹
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._=+/-]{8,}/g, `$1 ${REDACTED}`)
    // URL 임베디드 크리덴셜(scheme://user:pass@host) — user는 남기고 비밀번호만 마스킹
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]+@/gi, `$1:${REDACTED}@`)
    // KEY/TOKEN/SECRET/PASSWORD 대입(env·json·kv) — 키 이름 보존, 값만 마스킹.
    // 값: 따옴표 안(공백 허용) 또는 비따옴표 비공백 토큰. 키 이름과 구분자(=/:)는 원문 보존.
    .replace(
      /\b([A-Za-z_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD))\b("?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
      (_m, key, sep) => `${key}${sep}${REDACTED}`,
    );
}

/**
 * 레코드를 한 줄 JSON으로 직렬화(순수). text는 redact 후 MAX_TEXT로 캡하고, 그래도 라인이 MAX_LINE을
 * 넘으면 text를 요약 토큰으로 대체해 한 줄을 보장한다(events.jsonl serializeEvent 미러).
 */
export function serializeRecord(rec: ExtractionRecord): string {
  const out: ExtractionRecord = { ...rec };
  if (typeof out.text === "string") {
    let t = redactSecrets(out.text);
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + "…(절단)";
    out.text = t;
  }
  let line = JSON.stringify(out);
  if (line.length >= MAX_LINE && out.text !== undefined) {
    out.text = `(text ${rec.text?.length ?? 0}자 생략 — 라인 상한)`;
    line = JSON.stringify(out);
  }
  if (line.length >= MAX_LINE) line = line.slice(0, MAX_LINE - 1);
  return line;
}

/**
 * jsonl 원시 텍스트를 레코드 배열로 파싱(빈 줄·깨진 줄 skip). session+kind 문자열이 있어야 레코드로 인정
 * (events.jsonl parseEvents 미러 — 형상 오염 흡수).
 */
export function parseExtraction(raw: string): ExtractionRecord[] {
  const out: ExtractionRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object" && typeof obj.session === "string" && typeof obj.kind === "string") {
        out.push(obj as ExtractionRecord);
      }
    } catch {
      /* 깨진 줄 skip */
    }
  }
  return out;
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
  cwd: string,
  rec: ExtractionRecord,
  opts: { maxBytes?: number } = {},
): void {
  if (process.env.GBC_NO_EXTRACTION === "1") return;
  const maxBytes = opts.maxBytes ?? MAX_EXTRACTION_BYTES;
  try {
    const path = extractionPath(cwd);
    // 상한 이상이면 append 전에 1세대 로테이션(.jsonl→.1.jsonl, 기존 .1 덮어씀). stat 실패(파일 부재)는
    // 로테이션 없이 그대로 append(최초 기록).
    try {
      if (statSync(path).size >= maxBytes) renameSync(path, path.replace(/\.jsonl$/, ".1.jsonl"));
    } catch {
      /* stat/rename 실패(부재·권한) → 로테이션 생략, append는 시도 */
    }
    appendFileSync(path, serializeRecord(rec) + "\n");
  } catch {
    /* append 실패는 삼킨다(fail-silent — 계측이 A-mode 실행을 막지 않는다) */
  }
}
