import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Verdict } from "./types.js";

const execFileAsync = promisify(execFile);

const MODEL = process.env.GBC_MODEL ?? "claude-haiku-4-5";
const CLI_TIMEOUT_MS = 30000; // claude -p 폴백 상한(행 방지). 초과 시 kill → fail-open.

/**
 * 모델 토큰을 셸 안전 문자로 제한한다(win32 shell:true 경로의 argv 인젝션 차단).
 * GBC_MODEL은 사용자 env지만, 셸 경로에선 메타문자가 명령으로 새지 않게 화이트리스트만 통과.
 */
export function safeModel(model: string): string {
  return /^[\w.-]+$/.test(model) ? model : "claude-haiku-4-5";
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
  // native Windows는 claude.cmd라 별도 경로(아래) — POSIX는 검증된 경로 그대로(8/8 회귀 보존).
  if (process.platform === "win32") return judgeViaCliWin(system, user);
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", user, "--append-system-prompt", system, "--model", MODEL, "--output-format", "json"],
    { maxBuffer: 10 * 1024 * 1024, timeout: CLI_TIMEOUT_MS },
  );
  const env = JSON.parse(stdout);
  return env.result ?? "";
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
  return new Promise<string>((resolve, reject) => {
    const prompt = `${system}\n\n${user}`;
    const child = spawn("claude", ["-p", "--model", safeModel(MODEL), "--output-format", "json"], {
      shell: true,
    });
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
    child.stdout?.on("data", (d) => (out += String(d)));
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
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
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

export { GATE_SYSTEM, buildUserMessage, parseVerdict };
