// JUnit XML 리더 — verified 경로의 증거 소스. gbc는 테스트를 *실행하지 않고* 표준 결과 포맷을 *읽기만*
// 한다(RCE 차단·이식성). jest/vitest/pytest/go/cargo 등 모든 주요 러너가 JUnit 리포터를 내므로,
// 이 한 포맷만 읽으면 러너 불문 이식된다(provider 패턴). zero-dep 정규식 파서(런타임 의존성 보존).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** 테스트 1건의 판정. failure/error=fail, skipped=skipped, 그 외=pass. */
export type TestStatus = "pass" | "fail" | "skipped";

/** 기본 결과 경로(.gbc 하위) — 러너가 JUnit XML을 여기로 떨구도록 사용자/CI가 배선한다. */
export const JUNIT_DEFAULT_REL = join(".gbc", "verify-results.xml");

/** XML 엔티티 디코드(테스트명이 &amp;/&lt; 등으로 이스케이프돼 와도 spec ref와 매칭되게). */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&"); // &amp;는 마지막(이중 디코드 방지)
}

/** testcase 여는 태그 속성에서 name 추출(쌍/홑따옴표). 없으면 null. */
function extractName(attrs: string): string | null {
  const m = attrs.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/);
  if (!m) return null;
  return decodeXml(m[1] ?? m[2] ?? "");
}

/**
 * JUnit XML 문자열을 파싱해 testcase name → 판정 맵을 만든다.
 * - self-closing `<testcase .../>` 또는 본문 있는 `<testcase ...>...</testcase>` 모두 인식.
 * - 본문에 <failure>/<error> → fail · <skipped> → skipped · 그 외/본문없음 → pass.
 * - 동일 이름 중복(재시도·다중 suite) 시 fail이 sticky(한 번이라도 실패면 케이스 실패로 본다).
 * - 깨진/빈 XML은 throw하지 않고 부분 파싱(매칭 안 되면 빈 맵).
 */
export function parseJUnit(xml: string): Map<string, TestStatus> {
  const map = new Map<string, TestStatus>();
  // group1=속성, group2=본문(self-closing이면 undefined)
  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const name = extractName(m[1]);
    if (name === null) continue;
    const body = m[2];
    let status: TestStatus = "pass";
    if (body !== undefined) {
      if (/<(?:failure|error)\b/.test(body)) status = "fail";
      else if (/<skipped\b/.test(body)) status = "skipped";
    }
    const cur = map.get(name);
    // fail은 sticky — 이미 fail이면 유지, 새로 fail이면 격상.
    if (cur === undefined || status === "fail") map.set(name, status);
  }
  return map;
}

/**
 * .gbc/verify-results.xml(또는 지정 상대경로)을 읽어 파싱한다. 파일 부재/읽기 실패면 null.
 * ⚠️ 읽기 전용 — 절대 테스트를 실행하지 않는다(spec-유래 명령 spawn 금지=RCE 차단 불변식).
 */
export function readVerifyResults(cwd: string, relPath: string = JUNIT_DEFAULT_REL): Map<string, TestStatus> | null {
  const path = resolve(cwd, relPath);
  // 컨테인먼트(::file과 동일 방어계층, security-auditor S3) — relPath가 cwd 밖을 가리키면 읽지 않는다.
  // 현재 호출부는 상수 경로뿐이나, runVerify는 공개 API라 향후 경로 주입 시의 트래버설을 미리 차단.
  if (path !== cwd && !path.startsWith(cwd + sep)) return null;
  if (!existsSync(path)) return null;
  try {
    return parseJUnit(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
