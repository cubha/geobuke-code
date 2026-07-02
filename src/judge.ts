import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Verdict, ReviewVerdict, ScopeQueueEntry, ScopeVerdict, AxisAVerdict, RungVerdict } from "./types.js";

const MODEL = process.env.GBC_MODEL ?? "claude-haiku-4-5";
/**
 * scope 판정(축A/축B) 전용 모델 — 게이트 MODEL과 *물리 분리*(GBC_SCOPE_MODEL).
 * 기본 haiku(스파이크: grep 컨텍스트 있으면 haiku·sonnet 동률·오버클레임0). sonnet은 opt-in.
 * GBC_MODEL과 분리하는 이유: 공유 시 게이트/verify/scope 3중으로 sonnet 비용이 배증.
 */
const SCOPE_MODEL = process.env.GBC_SCOPE_MODEL ?? "claude-haiku-4-5";
const CLI_TIMEOUT_MS = 30000; // claude -p 폴백 상한(행 방지). 초과 시 kill → fail-open.

/**
 * 모델 토큰을 셸 안전 문자로 제한한다(win32 shell:true 경로의 argv 인젝션 차단).
 * GBC_MODEL은 사용자 env지만, 셸 경로에선 메타문자가 명령으로 새지 않게 화이트리스트만 통과.
 */
export function safeModel(model: string): string {
  return /^[\w.-]+$/.test(model) ? model : "claude-haiku-4-5";
}

/**
 * CLI 폴백 호출 구성(순수) — W2: 동적 user는 stdin, argv엔 정적 데이터(system 프롬프트·플래그·
 * 화이트리스트 모델)만 남긴다. user(diff·spec 포함)가 argv에 실리면 프로세스 목록(ps·procfs
 * cmdline)에 노출된다. system(GATE/REVIEW/SCOPE)은 전부 정적 const라 argv 유지가 안전하고,
 * --append-system-prompt 분리를 보존해 판정 품질 변수를 만들지 않는다.
 */
export interface CliInvocation {
  argv: string[];
  stdin: string;
}
export function buildCliInvocation(system: string, user: string, model: string): CliInvocation {
  return {
    argv: [
      "-p",
      "--append-system-prompt",
      system,
      "--model",
      safeModel(model),
      "--output-format",
      "json",
    ],
    stdin: user,
  };
}

/** resolveApiKey 의존성 주입(테스트용). 미지정 시 실제 env/homedir/fs 사용. */
export interface KeyResolveOpts {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  readFile?: (path: string) => string;
}

/**
 * API 키 해석 (크로스플랫폼, 셸 무관).
 * 1) ANTHROPIC_API_KEY 환경변수 우선, 2) 없으면 ~/.gbc/api-key 파일.
 * STUB
 */
export function resolveApiKey(opts: KeyResolveOpts = {}): string | null {
  const env = opts.env ?? process.env;
  const fromEnv = env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  const home = opts.homeDir ?? homedir();
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    // bash `$(cat)`는 trailing newline을 벗기지만 readFileSync는 안 벗긴다 → 명시 trim 필수.
    const key = read(join(home, ".gbc", "api-key")).trim();
    return key || null;
  } catch {
    return null; // 파일 부재/읽기 실패 → 키 없음(claude -p 폴백)
  }
}

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
(b) 계획 명세가 있다면: 이 편집이 작성/수정하는 *바로 그 기능*에 대해 계획에 적힌 형제 케이스 중, 이 편집에서도 안 다뤄지고 [명시적으로 미룬 항목]에도 [이미 완료된 항목]에도 없는 것이 있는가? → **block** (침묵 누락).
    - 예: 로그인 검증 함수를 쓰면서 계획의 로그인 검증 케이스(중복 이메일·비밀번호 길이 등)를 언급·등록 없이 빠뜨림.
    - 코드 주석으로 "나중에"라고만 적고 미룬 항목에 등록 안 한 것도 침묵 누락이다.
    - 계획이 요구한 동작 형태(예: 인라인 에러 메시지)를 충족 못 하고 다른 형태(예: bool만 반환)로 빠뜨린 것도 누락이다.
    - ★ [이미 완료된 항목]에 있는 케이스는 **이전 작업단위에서 이미 처리된 것**이다. 형제 후보에서 제외하고 절대 누락으로 다시 차단(re-flag)하지 마라. 이 편집과 무관한 과거 완료 케이스를 침묵누락이라 막는 것은 오탐이다.
(c) 위에 해당 없으면 → **pass**.

핵심 균형:
- 무관한 편집(1단계)을 "계획 케이스를 안 다뤘다"는 이유로 차단하지 마라(가장 흔한 오탐).
- 그러나 *같은 기능을 구현하는* 동작 편집이 계획된 형제 케이스를 침묵 누락하면 반드시 차단하라. "첫 케이스를 시작했다"는 이유로 나머지 침묵 누락을 눈감지 마라(가장 흔한 미탐). 한 편집이 모든 케이스를 *완전 구현*할 필요는 없지만, 형제 케이스는 최소한 다뤄지거나 명시 defer돼 있어야 한다.

오직 아래 JSON만 출력(설명·마크다운 펜스 금지):
{"verdict":"block"|"pass","missing":["누락된 케이스"],"reason":"한 줄 사유"}`;

function buildUserMessage(
  planSpec: string,
  editText: string,
  defers: string[],
  resolved: string[] = [],
): string {
  const fmt = (xs: string[]): string => (xs.length > 0 ? xs.map((d) => `- ${d}`).join("\n") : "(없음)");
  return `[계획 명세]
${planSpec.trim() || "(계획 명세 없음 — 개발자가 곧바로 구현을 시작함)"}

[명시적으로 미룬 항목]
${fmt(defers)}

[이미 완료된 항목]
${fmt(resolved)}

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

/** 트랜스포트 선택 결과 (디버그/리포트용). env 또는 키파일에 키가 있으면 api. */
export function selectedTransport(): "api" | "cli" {
  return resolveApiKey() ? "api" : "cli";
}

/** 직접 Anthropic API (haiku). SDK는 여기서만 lazy import → hook 핫패스 보호. */
async function judgeViaApi(system: string, user: string, temperature?: number): Promise<string> {
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = mod.default;
  // 키를 코드에서 해석(env 또는 ~/.gbc/api-key)해 명시 전달 — 셸 주입 불필요(크로스플랫폼).
  const client = new Anthropic({ apiKey: resolveApiKey() ?? undefined });
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    // temperature는 replay(회귀락)에서만 0으로 핀해 결정성을 높인다. 핫패스는 undefined=API 기본
    // (기존 판정 분포 보존). undefined면 키 자체를 안 보내 SDK 기본을 쓴다.
    ...(temperature !== undefined ? { temperature } : {}),
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
  // native Windows는 claude.cmd라 별도 경로(아래) — POSIX도 W2로 user=stdin 통일(0.5.3).
  if (process.platform === "win32") return judgeViaCliWin(system, user);
  return runClaudeCli(buildCliInvocation(system, user, MODEL));
}

/**
 * 공용 CLI 러너 — CliInvocation 계약(argv=정적, stdin=동적)을 spawn으로 실행. W2(0.5.3):
 * execFile argv-프롬프트 경로를 대체해 user가 프로세스 목록에 노출되지 않는다.
 * kill-timeout 필수 — 무응답 stdin이 판정을 무한 차단하면 안 됨 → 기존 CLI_TIMEOUT_MS 동일.
 */
function runClaudeCli(inv: CliInvocation, opts: { shell?: boolean } = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("claude", inv.argv, { shell: opts.shell ?? false });
    let out = "";
    let err = "";
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`claude -p 타임아웃(${CLI_TIMEOUT_MS}ms)`)));
    }, CLI_TIMEOUT_MS);
    child.stdout?.on("data", (d) => {
      out += String(d);
      // 구 execFile maxBuffer(10MB) 동등 방어 — 비정상 대형 스트림의 무한 누적 차단.
      if (out.length > 10 * 1024 * 1024) {
        child.kill();
        finish(() => reject(new Error("claude -p 응답 10MB 초과")));
      }
    });
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) =>
      finish(() => {
        if (code !== 0) {
          reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
          return;
        }
        try {
          resolve((JSON.parse(out).result as string) ?? "");
        } catch (e) {
          reject(e);
        }
      }),
    );
    child.stdin?.on("error", () => {
      /* EPIPE 등은 close/error 핸들러가 처리 */
    });
    child.stdin?.write(inv.stdin);
    child.stdin?.end();
  });
}

/**
 * native Windows 폴백. claude는 claude.cmd(배치 shim)라 Node 18+가 shell 없이 spawn 못 한다
 * (CVE-2024-27980 → ENOENT). shell:true로 실행하되, argv엔 동적 데이터를 절대 두지 않는다:
 * system+user를 합쳐 stdin으로 전달 → argv는 고정 플래그뿐이라 셸 메타문자 인젝션 표면이 없다.
 * (W3 stdin 결합은 WSL에서 claude -p 실측으로 판정 품질 동일 검증함 — POSIX/win32 양 경로의
 *  '판정 품질'만 프롬프트 전달 방식이 다르고, 이는 가시적 fail-open으로 바운드된다.)
 * kill-timeout 필수 — 무응답 stdin이 PreToolUse를 무한 차단하면 ENOENT보다 나쁘다 → fail-open 강제.
 */
function judgeViaCliWin(system: string, user: string): Promise<string> {
  // shell:true 경로라 argv엔 동적 데이터 절대 금지 — system조차 stdin에 결합(기존 검증된 형태 보존).
  return runClaudeCli(
    {
      argv: ["-p", "--model", safeModel(MODEL), "--output-format", "json"],
      stdin: `${system}\n\n${user}`,
    },
    { shell: true },
  );
}

/**
 * 게이트 판정. ANTHROPIC_API_KEY 있으면 직접 API(빠름), 없으면 claude -p 폴백.
 * 실패 시 안전하게 pass(fail-open) — 게이트가 개발을 막아버리는 사고 방지.
 */
export async function judge(
  planSpec: string,
  editText: string,
  defers: string[] = [],
  resolved: string[] = [],
  opts: { temperature?: number } = {},
): Promise<Verdict> {
  const user = buildUserMessage(planSpec, editText, defers, resolved);
  const transport = selectedTransport();
  try {
    // claude -p 폴백은 temperature 플래그가 없어 핀 불가 → CLI-transport replay는 best-effort.
    const raw =
      transport === "api"
        ? await judgeViaApi(GATE_SYSTEM, user, opts.temperature)
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
  return {
    verdict: "pass",
    missing: [],
    reason: `게이트 판정 실패(fail-open): ${String(e).slice(0, 160)}`,
    failOpen: true,
  };
}

// ===== reviewed 경로 (사후 결과검증, 러너 없는 경량) =====
// 게이트(구현 *전*)와 달리 reviewed는 구현 *후* 최종 코드를 독해해 케이스 주소화를 판정한다.
// 별도 프롬프트(refute-first)·독립 호출. fail-open은 'pass'가 아니라 'unverifiable'로 매핑한다.

const MAX_REVIEW_CODE = 12000; // 코드 본문 절단(프롬프트 비대 방지)

/**
 * reviewed 시스템 프롬프트 — refute-first. 기본값을 '미충족(fail)'에 두고, 코드에서 명확한 근거를
 * 찾았을 때만 pass. *독해 판정이지 동작 증명이 아님*을 명시(테스트 실행=verified와 구분).
 */
const REVIEW_SYSTEM = `너는 구현이 끝난 *뒤* 동작하는 코드 검토자다. [검증할 케이스]와 [최종 코드]를 보고
이 코드가 그 케이스를 실제로 다루는지 판정하라.

규칙:
- 기본값은 **fail(미충족)**이다. 코드에서 이 케이스가 구현됐다는 *명확한 근거*를 찾았을 때만 pass.
- 추측·선의 해석·"아마 될 것" 금지. 근거가 코드에 안 보이면 fail.
- 이것은 코드 *독해* 판정이다 — 테스트 실행이 아니다. 동작의 정확성(런타임 버그·경계조건)은 보증하지 못한다.
- 케이스와 무관한 코드면 fail(이 케이스를 다루지 않음).

오직 아래 JSON만 출력(설명·마크다운 펜스 금지):
{"status":"pass"|"fail","reason":"한 줄 사유"}`;

/** reviewed 사용자 메시지 — [검증할 케이스] / [최종 코드]. */
export function buildReviewMessage(caseText: string, fileContent: string): string {
  const code =
    fileContent.length > MAX_REVIEW_CODE
      ? fileContent.slice(0, MAX_REVIEW_CODE) + "\n…(절단됨)"
      : fileContent;
  return `[검증할 케이스]
${caseText.trim() || "(케이스 없음)"}

[최종 코드]
${code}`;
}

/**
 * reviewed 응답 파싱(순수). status가 pass/fail이면 그대로, 그 외/파싱불가는 **unverifiable**.
 * ⚠️ 어떤 실패 경로도 'pass'로 떨어지지 않는다(거짓 확신 차단) — 모르면 'unverifiable'.
 */
export function parseReviewVerdict(raw: string): ReviewVerdict {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { status: "unverifiable", reason: "검토 응답에서 JSON 미발견" };
    const j = JSON.parse(m[0]);
    const reason = typeof j.reason === "string" ? j.reason : "";
    if (j.status === "pass") return { status: "pass", reason };
    if (j.status === "fail") return { status: "fail", reason };
    // pass/fail 외(누락·block 등)는 신뢰 불가 → unverifiable(절대 pass로 떨구지 않음).
    return { status: "unverifiable", reason: reason || "알 수 없는 status" };
  } catch {
    return { status: "unverifiable", reason: "검토 응답 JSON 파싱 실패" };
  }
}

/** transport 무관 호출자 시그니처(테스트 주입용). */
export type ReviewInvoke = (system: string, user: string) => Promise<string>;

/**
 * reviewed 판정. 케이스 + 최종 코드 본문을 모델에 독해시켜 pass/fail. 호출 실패·타임아웃은
 * **unverifiable**로 매핑한다(failOpenVerdict의 'pass'를 복사하지 않는다 — reviewed의 핵심 가드).
 * STUB(ST3 RED).
 */
export async function judgeReviewed(
  caseText: string,
  fileContent: string,
  opts: { invoke?: ReviewInvoke } = {},
): Promise<ReviewVerdict> {
  const user = buildReviewMessage(caseText, fileContent);
  // 기본 호출자: 게이트와 동일 transport 선택(api 우선, 없으면 claude -p 폴백).
  const invoke: ReviewInvoke =
    opts.invoke ??
    ((system, u) =>
      selectedTransport() === "api" ? judgeViaApi(system, u) : judgeViaCli(system, u));
  try {
    return parseReviewVerdict(await invoke(REVIEW_SYSTEM, user));
  } catch (e) {
    // ⚠️ fail-open을 'pass'가 아닌 'unverifiable'로 — 검증 못 했으면 거짓 확신 대신 정직하게 모름.
    return { status: "unverifiable", reason: `검토 호출 실패(미검증): ${String(e).slice(0, 120)}` };
  }
}

// ===== scope 경로 (축A 파급반경 + 축B Ponytail 사다리) — 0.5.2 =====
// 게이트(GATE_SYSTEM, 침묵-누락)와 완전히 별도 호출. Stop 훅이 실제 grep으로 채운 [코드베이스
// 컨텍스트]를 근거로 판정한다. 하드가드는 *프롬프트가 아니라 코드*(parseScopeVerdicts)에서 강제:
// 컨텍스트 없는 파일의 축A·rung2 확신을 unknown으로 눌러 sonnet류 hallucination을 차단.

const MAX_SCOPE_EDIT = 1500; // 편집 본문 절단(배치 프롬프트 비대 방지)

/**
 * scope 시스템 프롬프트 — 축A(파급반경)·축B(Ponytail 사다리)를 편집별로 판정.
 * 정직 규율: [코드베이스 컨텍스트]에서 근거를 못 찾으면 추측하지 말고 "unknown". 모름을 "ok"·"broken"
 * ·"rung2"로 확신하는 것이 가장 위험. (코드 하드가드가 이를 이중으로 강제하지만 프롬프트도 정렬.)
 */
const SCOPE_SYSTEM = `너는 코드 편집이 방금 통과한 *뒤* 동작하는 품질 검토자다. 여러 편집과 그에 대한
[코드베이스 컨텍스트](실제 grep 결과)를 받아, 편집마다 두 축을 판정한다. 이것은 차단이 아니라 권고다.

[축A — 파급반경] 이 편집과 같은 원인의 문제가 직접 인접 경계(①직접 호출부 ②API/데이터 계약 ③공유 상태)
너머에서도 재발하는가?
- "ok": 재발 없음이 컨텍스트로 확인됨
- "broken": 같은 원인이 인접 경계 너머 재발(axisAReason에 어느 파일·경계인지 구체 명시)
- "unknown": 판단할 컨텍스트가 없음 — 추측 금지, 모르면 unknown

[축B — 최소구현 사다리] 이 편집이 쓰는 새 코드에 대해 순서대로: rung1(YAGNI: 요청 안 한 기능 선구현) →
rung2(기존 코드 재사용 가능 — [코드베이스 컨텍스트]에 유사 유틸이 보이면) → rung3(표준 라이브러리로 대체
가능). 먼저 걸리는 하나만. 가드레일(사다리 대상 아님): trust-boundary 검증·보안·접근성·데이터손실 처리,
TDD RED 실패 테스트. 해당 없으면 "none". 컨텍스트 없어 rung2를 확신 못 하면 "unknown".
- rung은 "rung1"|"rung2"|"rung3"|"none"|"unknown". rungReason은 근거(재사용 후보는 "유사명 발견, 확인 필요" 톤).

오직 아래 JSON 배열만 출력(편집마다 하나, 설명·펜스 금지). file은 입력의 파일 경로 그대로:
[{"file":"경로","axisA":"ok|broken|unknown","axisAReason":"한 줄","rung":"rung1|rung2|rung3|none|unknown","rungReason":"한 줄"}]`;

/**
 * 배치 사용자 메시지 — 계획 명세 + 편집 목록 + 실제 grep 컨텍스트.
 * 계획 명세를 포함하는 이유: rung1(YAGNI="요청 안 한 기능")은 요청이 무엇이었는지 없이는 판정
 * 불가 — 스파이크의 rung1 정확도는 명세 존재 조건에서 검증된 것이라 판정 조건을 그에 정렬한다.
 */
export function buildScopeMessage(
  entries: ScopeQueueEntry[],
  grepContext: string,
  planSpec = "",
): string {
  const edits = entries
    .map((e, i) => {
      const body = e.edit.length > MAX_SCOPE_EDIT ? e.edit.slice(0, MAX_SCOPE_EDIT) + "\n…(절단)" : e.edit;
      return `[편집 ${i + 1}] file=${e.file} (${e.tool})\n${body}`;
    })
    .join("\n\n");
  return `[계획 명세]
${planSpec.trim() || "(계획 명세 없음)"}

[편집 목록]
${edits}

[코드베이스 컨텍스트]
${grepContext.trim() || "(탐색 결과 없음 — 이 편집들의 인접 호출부·유사 유틸을 grep으로 찾지 못함)"}`;
}

function coerceAxisA(v: unknown): AxisAVerdict {
  return v === "ok" || v === "broken" ? v : "unknown";
}
function coerceRung(v: unknown): RungVerdict {
  return v === "rung1" || v === "rung2" || v === "rung3" || v === "none" ? v : "unknown";
}

/**
 * 배치 응답을 편집별 ScopeVerdict로 파싱 + **코드 하드가드**.
 * - 응답에 없는 파일 → unknown+degraded(모델이 판정 안 함).
 * - 파싱 불가 → 전 엔트리 unknown+degraded(broken/rung2 조작 절대 금지).
 * - filesWithContext에 없는 파일 → axisA를 unknown으로, rung2를 unknown으로 강제(탐색 근거 없는
 *   확신 차단). rung1/rung3/none은 grep 무관이라 유지. degraded=true로 정직 고지.
 */
export function parseScopeVerdicts(
  raw: string,
  entries: ScopeQueueEntry[],
  filesWithContext: Set<string>,
): ScopeVerdict[] {
  let byFile = new Map<string, { axisA: unknown; axisAReason?: unknown; rung: unknown; rungReason?: unknown }>();
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        for (const o of arr) {
          if (o && typeof o.file === "string") byFile.set(o.file, o);
        }
      }
    }
  } catch {
    byFile = new Map(); // 파싱 실패 → 전부 unknown 경로로
  }

  return entries.map((e) => {
    const found = byFile.get(e.file);
    const hasCtx = filesWithContext.has(e.file);
    let axisA: AxisAVerdict;
    let rung: RungVerdict;
    let axisAReason: string;
    let rungReason: string;
    let degraded = false;

    if (!found) {
      // 모델이 이 편집을 판정하지 않음 → 정직하게 미평가.
      axisA = "unknown";
      rung = "unknown";
      axisAReason = "모델 응답에 이 편집 판정 없음";
      rungReason = "";
      degraded = true;
    } else {
      axisA = coerceAxisA(found.axisA);
      rung = coerceRung(found.rung);
      axisAReason = typeof found.axisAReason === "string" ? found.axisAReason : "";
      rungReason = typeof found.rungReason === "string" ? found.rungReason : "";
    }

    // 코드 하드가드: 탐색 컨텍스트 없는 파일은 축A·rung2 확신 불가 → 눌러서 정직 처리.
    if (!hasCtx) {
      degraded = true;
      if (axisA !== "unknown") {
        axisAReason = "탐색 컨텍스트 없음 — 파급반경 판정 생략";
        axisA = "unknown";
      }
      if (rung === "rung2") {
        rungReason = "탐색 컨텍스트 없음 — 기존 코드 재사용 여부 확인 불가";
        rung = "unknown";
      }
    }

    return { file: e.file, axisA, axisAReason, rung, rungReason, degraded };
  });
}

/** transport 무관 호출자(테스트 주입용). 게이트와 동일 선택(api 우선), 단 모델은 SCOPE_MODEL. */
export type ScopeInvoke = (system: string, user: string) => Promise<string>;

async function scopeViaApi(system: string, user: string): Promise<string> {
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = mod.default;
  const client = new Anthropic({ apiKey: resolveApiKey() ?? undefined });
  const resp = await client.messages.create({
    model: SCOPE_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });
  const texts: string[] = [];
  for (const block of resp.content) if (block.type === "text") texts.push(block.text);
  return texts.join("");
}

async function scopeViaCli(system: string, user: string): Promise<string> {
  if (process.platform === "win32") return judgeViaCliWin(system, user);
  return runClaudeCli(buildCliInvocation(system, user, SCOPE_MODEL));
}

/** scope 판정 하드 타임아웃(ms) — Stop 훅 체감 지연 상한. 초과 시 fail-open(unknown+degraded). */
export const SCOPE_TIMEOUT_MS = 10000;

/** ms 초과 시 reject하는 race 래퍼 — SDK 기본 타임아웃(수분)이 Stop UX를 잡아먹지 않게 한다. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`scope 판정 타임아웃(${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * scope 배치 판정. 편집 목록 + grep 컨텍스트를 한 번에 판정한다(축 섞기 회귀는 GATE_SYSTEM과의
 * 혼합에서 왔으므로 여기선 전용 프롬프트). 호출 실패·**타임아웃(SCOPE_TIMEOUT_MS)**은 전 엔트리
 * unknown+degraded로 fail-open(게이트의 'pass'도, block도 아님 — 사후 권고라 조용히 미평가).
 * 하드가드는 파서가 적용. 실패 사유는 반환 verdict의 axisAReason에 담겨 호출자가 계측한다.
 */
export async function judgeScope(
  entries: ScopeQueueEntry[],
  grepContext: string,
  filesWithContext: Set<string>,
  opts: { invoke?: ScopeInvoke; timeoutMs?: number; planSpec?: string } = {},
): Promise<ScopeVerdict[]> {
  if (entries.length === 0) return [];
  const user = buildScopeMessage(entries, grepContext, opts.planSpec ?? "");
  const invoke: ScopeInvoke =
    opts.invoke ?? ((s, u) => (selectedTransport() === "api" ? scopeViaApi(s, u) : scopeViaCli(s, u)));
  const timeoutMs = opts.timeoutMs ?? SCOPE_TIMEOUT_MS;
  try {
    const raw = await withTimeout(invoke(SCOPE_SYSTEM, user), timeoutMs);
    return parseScopeVerdicts(raw, entries, filesWithContext);
  } catch (e) {
    // fail-open: 미평가로 정직 처리(확신 조작 금지). 하드가드와 동일한 unknown 바닥.
    return entries.map((entry) => ({
      file: entry.file,
      axisA: "unknown" as AxisAVerdict,
      axisAReason: `scope 판정 호출 실패(미평가): ${String(e).slice(0, 120)}`,
      rung: "unknown" as RungVerdict,
      rungReason: "",
      degraded: true,
    }));
  }
}

export { GATE_SYSTEM, buildUserMessage, parseVerdict, REVIEW_SYSTEM, SCOPE_SYSTEM, SCOPE_MODEL };
