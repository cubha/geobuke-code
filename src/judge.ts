import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Verdict } from "./types.js";

const execFileAsync = promisify(execFile);

const MODEL = process.env.GBC_MODEL ?? "claude-haiku-4-5";

/**
 * 최소 게이트 시스템 프롬프트.
 * 의미론(핵심): 한 편집이 모든 케이스를 *완전 구현*할 필요는 없다.
 * 침묵 누락(언급도 명시 defer도 없이 빠뜨림)과 시나리오 미지정만 차단한다.
 */
const GATE_SYSTEM = `너는 코드 구현 직전에 동작하는 "게이트"다. 개발자가 막 파일을 편집하려 한다.
[계획 명세]·[현재 편집]·[명시적으로 미룬 항목]을 보고 통과(pass)/차단(block)을 판정하라.

[1단계 — 편집의 종류 분류]
이 편집이 프로그램의 *동작(behavior)을 구현하거나 바꾸는* 코드 편집인가, 아니면 동작과 무관한 편집인가?
- 동작과 무관한 편집 → **무조건 pass.** 예: 문서/README 수정, 단순 변수·함수 리네임, 포매팅/들여쓰기, 주석만 추가, 동작 불변 리팩터, 설정/빌드 파일 변경.
  (판별 팁: 함수 본문의 로직/검증/분기/반환을 새로 쓰거나 바꾸면 "동작 편집". 이름만 바꾸거나 글자만 옮기면 "무관".)
- 동작을 구현/변경하는 코드 편집 → 2단계로.

[2단계 — 동작 편집일 때만 검사]
(a) [계획 명세]가 없거나 빈약해서 이 동작의 의도·시나리오가 미지정인 채 구현되고 있는가? → **block** (시나리오 미지정).
(b) 계획 명세가 있다면: 이 편집이 작성/수정하는 *바로 그 기능*에 대해 계획에 적힌 형제 케이스 중, 이 편집에서도 안 다뤄지고 [명시적으로 미룬 항목]에도 없는 것이 있는가? → **block** (침묵 누락).
    - 예: 로그인 검증 함수를 쓰면서 계획의 로그인 검증 케이스(중복 이메일·비밀번호 길이 등)를 언급·등록 없이 빠뜨림.
    - 코드 주석으로 "나중에"라고만 적고 미룬 항목에 등록 안 한 것도 침묵 누락이다.
    - 계획이 요구한 동작 형태(예: 인라인 에러 메시지)를 충족 못 하고 다른 형태(예: bool만 반환)로 빠뜨린 것도 누락이다.
(c) 위에 해당 없으면 → **pass**.

핵심 균형:
- 무관한 편집(1단계)을 "계획 케이스를 안 다뤘다"는 이유로 차단하지 마라(가장 흔한 오탐).
- 그러나 *같은 기능을 구현하는* 동작 편집이 계획된 형제 케이스를 침묵 누락하면 반드시 차단하라. "첫 케이스를 시작했다"는 이유로 나머지 침묵 누락을 눈감지 마라(가장 흔한 미탐). 한 편집이 모든 케이스를 *완전 구현*할 필요는 없지만, 형제 케이스는 최소한 다뤄지거나 명시 defer돼 있어야 한다.

오직 아래 JSON만 출력(설명·마크다운 펜스 금지):
{"verdict":"block"|"pass","missing":["누락된 케이스"],"reason":"한 줄 사유"}`;

function buildUserMessage(planSpec: string, editText: string, defers: string[]): string {
  const deferText = defers.length > 0 ? defers.map((d) => `- ${d}`).join("\n") : "(없음)";
  return `[계획 명세]
${planSpec.trim() || "(계획 명세 없음 — 개발자가 곧바로 구현을 시작함)"}

[명시적으로 미룬 항목]
${deferText}

[현재 편집]
${editText}`;
}

function parseVerdict(raw: string): Verdict {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`게이트 응답에서 JSON을 찾지 못함: ${raw.slice(0, 200)}`);
  const j = JSON.parse(m[0]);
  const verdict = j.verdict === "block" ? "block" : "pass";
  return {
    verdict,
    missing: Array.isArray(j.missing) ? j.missing.map(String) : [],
    reason: typeof j.reason === "string" ? j.reason : "",
  };
}

/** 트랜스포트 선택 결과 (디버그/리포트용) */
export function selectedTransport(): "api" | "cli" {
  return process.env.ANTHROPIC_API_KEY ? "api" : "cli";
}

/** 직접 Anthropic API (haiku). SDK는 여기서만 lazy import → hook 핫패스 보호. */
async function judgeViaApi(system: string, user: string): Promise<string> {
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = mod.default;
  const client = new Anthropic(); // ANTHROPIC_API_KEY 환경변수 사용
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });
  const texts: string[] = [];
  for (const block of resp.content) {
    if (block.type === "text") texts.push(block.text);
  }
  return texts.join("");
}

/** claude -p 폴백 (무설정 도그푸딩용, 느림). CC의 기존 인증 사용. */
async function judgeViaCli(system: string, user: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", user, "--append-system-prompt", system, "--model", MODEL, "--output-format", "json"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const env = JSON.parse(stdout);
  return env.result ?? "";
}

/**
 * 게이트 판정. ANTHROPIC_API_KEY 있으면 직접 API(빠름), 없으면 claude -p 폴백.
 * 실패 시 안전하게 pass(fail-open) — 게이트가 개발을 막아버리는 사고 방지.
 */
export async function judge(
  planSpec: string,
  editText: string,
  defers: string[] = [],
): Promise<Verdict> {
  const user = buildUserMessage(planSpec, editText, defers);
  const transport = selectedTransport();
  try {
    const raw =
      transport === "api"
        ? await judgeViaApi(GATE_SYSTEM, user)
        : await judgeViaCli(GATE_SYSTEM, user);
    return parseVerdict(raw);
  } catch (e) {
    return failOpenVerdict(e);
  }
}

/**
 * 판정 호출 실패 시의 안전 통과(fail-open) verdict.
 * failOpen=true로 표시해 hook이 캐시 제외·계측할 수 있게 한다.
 */
export function failOpenVerdict(e: unknown): Verdict {
  // STUB(잘못된 버전): failOpen 플래그 누락 — ST1 유효 RED 유도용
  return {
    verdict: "pass",
    missing: [],
    reason: `게이트 판정 실패(fail-open): ${String(e).slice(0, 160)}`,
  };
}

export { GATE_SYSTEM, buildUserMessage, parseVerdict };
