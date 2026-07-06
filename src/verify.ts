// 사후 결과검증(post-impl verify) — spec 케이스를 *증거*(테스트결과/파일)와 대조해 판정한다.
// 핵심 불변식: gbc는 테스트를 *실행하지 않는다*. 표준 결과 포맷(JUnit XML)을 *읽고*, 러너가 없으면
// LLM 독해(reviewed)로 경량 판정하거나 unverifiable로 정직 보고한다(provider 패턴·RCE 차단·이식성).
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CaseBinding, CaseVerdict, VerifyReport, VerifyProvenance, ReviewVerdict } from "./types.js";
import { readSpecCases } from "./spec.js";
import { readVerifyResults, statVerifyResults, JUNIT_DEFAULT_REL } from "./junit.js";
import { judgeReviewed } from "./judge.js";
import { parseEvents, lastAppliedEditAt } from "./metrics.js";
import { nowIso } from "./time.js";

/**
 * spec 케이스 텍스트에서 검증 바인딩 접미사를 파싱한다.
 *   "<케이스 본문> ::test <테스트명>"   → { text: 본문, kind:"test", ref: 테스트명 }
 *   "<케이스 본문> ::file <경로>"        → { text: 본문, kind:"file", ref: 경로 }
 *   "<케이스 본문> ::test \"이름 공백\""  → 따옴표로 공백 포함 ref(BDD 스타일 테스트명)
 *   접미사 없음 / ref 없음                → { text: 원문, kind:"none", ref:"" }
 *
 * 규약(도그푸딩 정정 2026-06-26): 바인딩은 **줄 끝의 트레일링 접미사**다 — ref는 단일 토큰(\S+) 또는
 * 따옴표 묶음. 산문 중간의 우연한 "::test 바인딩을…" 같은 언급은 뒤에 토큰이 더 이어지면 매칭되지
 * 않는다(end-anchored). 마커가 여러 개면 *마지막 유효 트레일링 바인딩*이 이긴다(산문 언급은 무시).
 * 마커 직후 공백(`[ \t]+`) 강제로 `::testing` 단어 내부 매칭도 배제. ref 없으면 none → unverifiable.
 */
export function parseBinding(caseText: string): CaseBinding {
  const m = caseText.match(/^(.*?)\s*::(test|file)[ \t]+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/);
  if (!m) return { text: caseText.trim(), kind: "none", ref: "" };
  const ref = (m[3] ?? m[4] ?? m[5] ?? "").trim();
  return { text: m[1].trim(), kind: m[2] as "test" | "file", ref };
}

/** runVerify 옵션 — 테스트 주입(reviewer·junit경로·시각). */
export interface VerifyOpts {
  /** JUnit 결과 상대경로(기본 .gbc/verify-results.xml) */
  junitRel?: string;
  /** reviewed 판정자 주입(기본 judgeReviewed). 단위테스트가 LLM 없이 라우팅을 검증하게 한다. */
  reviewer?: (caseText: string, fileContent: string) => Promise<ReviewVerdict>;
  /** 리포트 시각(ISO) 주입 */
  now?: string;
  /**
   * 마지막 적용 편집 시각(ISO) 주입 — provenance 신선도 기준(0.6.0).
   * undefined=기본(.gbc/events.jsonl 판독) · null=신호 없음(unknown 경로) · string=고정 주입.
   */
  lastEditAt?: string | null;
}

/** .gbc/events.jsonl에서 마지막 적용 편집 시각을 판독(기본 신선도 신호원). 부재/실패면 null. */
function readLastEditAt(cwd: string): string | null {
  const path = join(cwd, ".gbc", "events.jsonl");
  if (!existsSync(path)) return null;
  try {
    return lastAppliedEditAt(parseEvents(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** unverifiable CaseVerdict 헬퍼. */
function unverifiable(caseText: string, evidence: string, source: string): CaseVerdict {
  return { case: caseText, level: "unverifiable", status: "none", evidence, source };
}

/**
 * spec 케이스를 바인딩별로 라우팅해 사후검증한다 — 판정 사다리:
 *   ::test → JUnit 결과 읽어 verified(pass/fail) · 결과/매칭 없으면 unverifiable
 *   ::file → 최종 코드 LLM 독해(reviewed pass/fail) · fail-open/파일없음은 unverifiable
 *   none   → unverifiable(검증 바인딩 없음)
 * gbc는 테스트를 실행하지 않는다(읽기만) — git diff도 쓰지 않는다(::file 명시 경로=git-agnostic 보존).
 */
export async function runVerify(cwd: string, opts: VerifyOpts = {}): Promise<VerifyReport> {
  const junitRel = opts.junitRel ?? JUNIT_DEFAULT_REL;
  const reviewer = opts.reviewer ?? ((c, f) => judgeReviewed(c, f));
  // JUnit 결과는 run당 1회만 읽는다(케이스마다 재파싱 방지).
  const junit = readVerifyResults(cwd, junitRel);

  // provenance 신선도(0.6.0) — 결과파일 mtime vs 마지막 적용 편집(events.jsonl).
  // stale이면 verified 대신 unverifiable로 강등(pass·fail 대칭 — 옛 증거로 확신도 경보도 안 함).
  // 편집 신호 부재는 stale로 뭉개지 않고 unknown 고지(hook 미설치 standalone 오탐 방지).
  const junitMtime = junit ? (statVerifyResults(cwd, junitRel) ?? undefined) : undefined;
  const lastEditAt = opts.lastEditAt === undefined ? readLastEditAt(cwd) : opts.lastEditAt;
  const stale = junitMtime !== undefined && lastEditAt !== null && junitMtime < lastEditAt;
  const provenance: VerifyProvenance = {
    junitMtime,
    lastEditAt: lastEditAt ?? undefined,
    stale,
    unknown: junitMtime !== undefined && lastEditAt === null,
  };

  const cases: CaseVerdict[] = [];
  for (const raw of readSpecCases(cwd)) {
    const b = parseBinding(raw);
    if (b.kind === "test") {
      if (!junit) {
        cases.push(unverifiable(b.text, `테스트 결과 파일 없음(${junitRel})`, "junit:none"));
      } else if (stale) {
        // 결과 존재 여부와 무관하게 stale이면 verified 승격 금지 — 결과 상태는 참고로만 남긴다.
        const st = junit.get(b.ref);
        const hint = st === "pass" || st === "fail" ? `옛 결과=${st} · ` : "";
        cases.push(
          unverifiable(
            b.text,
            `${hint}stale 강등: 결과(${junitMtime}) < 마지막 편집(${lastEditAt}) — 러너 재실행 필요`,
            "junit:stale",
          ),
        );
      } else {
        const st = junit.get(b.ref);
        if (st === "pass") {
          cases.push({ case: b.text, level: "verified", status: "pass", evidence: `테스트 '${b.ref}' 통과`, source: `junit:${junitRel}` });
        } else if (st === "fail") {
          cases.push({ case: b.text, level: "verified", status: "fail", evidence: `테스트 '${b.ref}' 실패`, source: `junit:${junitRel}` });
        } else if (st === "skipped") {
          cases.push(unverifiable(b.text, `테스트 '${b.ref}' skip(미실행)`, "junit:skipped"));
        } else {
          cases.push(unverifiable(b.text, `테스트 '${b.ref}' 결과 미발견`, "junit:miss"));
        }
      }
    } else if (b.kind === "file") {
      const abs = resolve(cwd, b.ref);
      // 보안: spec.md는 커밋/PR 기여 파일이라 ::file ref가 cwd 밖(예: ~/.ssh/id_rsa)을 가리키면
      // 그 내용을 읽어 LLM API로 보내는 유출 벡터가 된다. 2중 차단:
      //  ① 어휘 컨테인먼트 — 경로 문자열이 cwd 밖이면 거부.
      if (abs !== cwd && !abs.startsWith(cwd + sep)) {
        cases.push(unverifiable(b.text, `프로젝트 밖 파일 참조 거부: ${b.ref}`, "review:outside"));
      } else {
        //  ② lstatSync 단일 호출 — 부재·심링크·비정규파일을 한 번에 거부(TOCTOU 없이).
        //  resolve는 어휘 연산이라 cwd 내부 심링크가 밖을 가리키는 것을 못 막는다(scope-critic 高).
        //  lstat은 링크를 안 따라가 isFile()=false → 거부(cli.ts:649·769 cmdMetrics/cmdRepos W1 선례).
        let isFile = false;
        try {
          isFile = lstatSync(abs).isFile();
        } catch {
          /* 부재/권한오류 → isFile=false */
        }
        if (!isFile) {
          cases.push(unverifiable(b.text, `파일 없음/비정규(심링크 등): ${b.ref}`, "review:nofile"));
        } else {
          let content = "";
          try {
            content = readFileSync(abs, "utf8");
          } catch {
            cases.push(unverifiable(b.text, `파일 읽기 실패: ${b.ref}`, "review:noread"));
            continue;
          }
          const rv = await reviewer(b.text, content);
          if (rv.status === "pass") {
            cases.push({ case: b.text, level: "reviewed", status: "pass", evidence: rv.reason || `독해: 충족(${b.ref})`, source: `review:${b.ref}` });
          } else if (rv.status === "fail") {
            cases.push({ case: b.text, level: "reviewed", status: "fail", evidence: rv.reason || `독해: 미충족(${b.ref})`, source: `review:${b.ref}` });
          } else {
            cases.push(unverifiable(b.text, rv.reason || "검토 미수행", `review:${b.ref}`));
          }
        }
      }
    } else {
      cases.push(unverifiable(b.text, "검증 바인딩 없음(::test/::file 미지정)", "none"));
    }
  }

  return { cases, at: opts.now ?? nowIso(), provenance };
}
