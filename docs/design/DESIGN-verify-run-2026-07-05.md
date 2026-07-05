# DESIGN — `gbc verify --run` (0.6.0 ST-D)

> 작성: 2026-07-05 · 상태: advisor 재검증 대기 → 구현
> 성격: **RCE 차단 불변식의 의도적·국소적 경계 변경.** 0.6.0을 patch가 아닌 minor로 만드는 근거.

## 1. 목적

verified 사다리 칸의 마찰 제거. 현재 사용자는 러너를 *직접* 실행해 `.gbc/verify-results.xml`을
만든 뒤 `gbc verify`를 해야 한다(2단계). `--run`은 이 두 단계를 하나로 — **사용자가 고정(pin)한
러너 명령을 실행한 직후 표준 결과를 읽어** 판정한다.

## 2. 불변식 재정의 (before → after)

- **before**: "gbc는 테스트를 실행하지 않는다."
- **after**: "gbc는 **spec-유래 명령을 절대 실행하지 않는다**. 실행하는 것은 오직 **신뢰 소스가
  고정한 러너 명령** 하나뿐이며, 그 명령 문자열에 spec/defer/판정 출력 등 저장소-기여 데이터가
  절대 섞이지 않는다."
- 판정·읽기 경로(junit.ts `readVerifyResults` "실행 금지" 주석)는 **불변** — 실행은 verify.ts/junit.ts
  가 아닌 CLI 계층(cli.ts)의 별도 함수가 담당하고, runVerify는 여전히 읽기만 한다(계층 분리).

## 3. 위협 모델

| 벡터 | 방어 |
|---|---|
| **spec.md 유래 명령** (spec.md=PR 기여 파일 → 공급망 RCE) | 명령 소스에서 **구조적으로 배제** — 명령 해석 함수(resolveRunCommand)는 spec/defer/pending-review를 입력으로 받지 않는다(파라미터에 없음 = 코드 형상으로 차단) |
| **spec 내용의 명령행 보간** | 실행 명령은 리터럴 문자열 그대로 — 어떤 템플릿/보간도 없음 |
| **repo-기여 파일로 명령 심기** (PR이 `.gbc/config.json` 강제 커밋 등) | 저장 위치가 repo 밖(`~/.gbc/verify-run.json`) — PR은 사용자 홈을 쓸 수 없어 **벡터 구조적 소멸**(advisor #1: gitignore 어휘 경고안은 거짓 음성이라 기각) |
| **러너가 결과 미갱신(리포터 미배선·timeout·고아)인데 옛 XML로 verified** | **run-start mtime 검사**(advisor #3): spawn 직전 시각을 provenance `lastEditAt`으로 주입 → 결과 mtime이 그보다 새것 아니면 ST-A 메커니즘이 unverifiable 강등 + "리포터 배선 확인(--init)" 안내 |
| **allowlist 격상(confused deputy)** — `Bash(gbc *)` allowlist 시 --run 인자형이 에이전트 무프롬프트 임의 실행권이 되고, spec.md 인젝션이 LLM 경유로 세탁될 수 있음 | gbc 코드로 완전 차단 불가(에이전트는 Bash로도 실행 가능) — **README에 "`gbc` 와일드카드 allowlist 시 --run 주의" 명기**(advisor #6a). "gbc 프리픽스=안전" 속성 상실을 문서로 정직 고지 |
| **재귀 실행** (pin 명령이 --run을 재포함 → 10분 타이머 중첩 폭주) | env 가드 `GBC_RUN_ACTIVE=1`이면 --run 거부(advisor #6b) |
| **행(hang)** | kill-timeout — `GBC_RUN_TIMEOUT_MS`(기본 600000=10분, 러너는 judge 30s와 자릿수가 다름). judge.ts kill-timeout 선례 미러 |
| **셸 메타문자** | `shell:true`로 실행하되(크로스플랫폼·파이프 허용), 명령은 신뢰 소스(사용자가 타이핑/저장)라 사용자 자신의 셸 명령과 동급. 신뢰 경계는 "누가 명령을 정했나"이지 "메타문자 유무"가 아니다 |

## 4. 명령 소스와 CLI 표면 (신뢰 소스 = 정확히 2개) — advisor #1 반영

1. **CLI 인자** — `gbc verify --run "npm test"` : 사용자가 지금 타이핑한 명령. 1회성(저장 안 함).
2. **홈 pin** — `gbc verify --run` (인자 없음) : **`~/.gbc/verify-run.json`의 `{[repoPath]: cmd}`**.
   - 저장: `gbc verify --run --save "npm test"` → 홈 pin 기록 후 실행 + 1줄 고지("이후 인자 없는
     --run이 이 명령을 그대로 실행").
   - pin도 없으면: 실행하지 않고 설정법 안내 + exit 1 (침묵 no-op 금지).

⚠️ **`.gbc/config.json`(repo 내부)은 명령 소스로 부적격** (advisor Critical): PR이 `git add -f`로
`.gbc/config.json`을 커밋해 오면 gitignore 어휘 검사(untracked에만 작용)는 거짓 음성이고, 경고는
stdio inherit 러너 출력에 묻힌다. 홈 이전으로 repo-기여 벡터가 **구조적으로 소멸** — 경고도 git
명령도 불필요(repos.json `~/.gbc` 선례 미러). 트레이드오프(팀 간 repo 경유 명령 공유 불가)는
비용이 아니라 목적이다.

우선순위: CLI 인자 > 홈 pin. `--save`는 인자 필수.

## 5. 실행 시맨틱

- 실행 직전 **명령 원문+소스를 에코**(`실행: <cmd> (소스: 인자|홈 pin)`) — 가시성은 공짜 방어(advisor #2).
- `spawn(cmd, { shell: true, cwd, stdio: "inherit" })` — 러너 출력을 사용자에게 그대로(캡처 안 함,
  출력 가공/LLM 전송 없음). 한계: timeout `child.kill()`은 셸만 죽이고 손자 프로세스는 고아로 남을
  수 있음(detached 그룹 kill은 스코프 비대로 비채택) — run-start mtime 검사가 고아의 늦은 XML을
  해당 run의 증거로 오인하는 것까지 막지는 못하나 다음 verify에서 stale로 잡힌다.
- 러너 exit code는 **게이트하지 않는다** — 실패 테스트가 있으면 러너가 비0으로 끝나는 게 정상이고,
  판정은 JUnit XML(fail 케이스)이 담당. 러너 종료 후 항상 기존 `gbc verify` 읽기 경로 실행.
- spawn 자체 실패(ENOENT 등)/timeout: 정직 보고 후 **그대로 읽기 경로 진행** — run-start 시각을
  provenance 기준으로 주입하므로(위 표) 미갱신 옛 결과는 unverifiable로 강등된다(A와 D의 맞물림).
  events.jsonl 의존 없음 — hook 미설치 standalone에서도 이 검사는 성립(advisor #3의 unknown 갭 폐쇄).
- 계측: 기존 `logCli(cwd, "verify", …)` 유지(명령 문자열은 이벤트에 기록하지 않음 — privacy 불변식).

## 6. 구현 형상 (계층 분리)

- `repos.ts`(홈 `~/.gbc` 소유 모듈): `getVerifyRunPin(repoPath)` / `setVerifyRunPin(repoPath, cmd)` —
  `~/.gbc/verify-run.json` `{[repoPath]: cmd}` (repos.json 동위·미러).
- `cli.ts`: `cmdVerify(args)`에 `--run [--save] [명령]` 분기 → `runVerifyCommand(cmd)`(spawn+timeout)
  → 완료 후 기존 verify 읽기 경로 재사용.
- **verify.ts/junit.ts 무변경** — 읽기 계층에 실행 코드가 스미지 않는다.
- 순수 로직(`resolveRunCommand(argv, config)`: 소스 우선순위·--save 파싱)은 단위 테스트.
  spawn 껍데기는 TDD 제외(실행 부작용) — 계획 확정대로.

## 7. 비목표 (재제안 방지)

- spec 케이스별 명령/케이스-필터 실행(예: `::test` 이름을 러너 인자로 전달) — **spec-유래 문자열이
  명령행에 오르는 순간 RCE 벡터 부활.** 영구 금지. **합법적 배출구**(advisor #5): 필터가 필요하면
  사용자가 `npm test -- -t "이름"`처럼 **필터를 명령 리터럴에 직접 포함해 pin**하면 된다 — 이것이
  이 요구의 정답이며 spec-유래 문자열은 여전히 명령행에 오르지 않는다.
- 자동 러너 감지 실행(감지는 --init 스캐폴딩까지 — 실행 명령은 반드시 사람이 고정).
- 러너 출력 파싱/요약(LLM 전송) — 결과는 JUnit 파일로만.

## 8. advisor 재검증 결과 (2026-07-05) — 조건부 진행 가 → 조건 전부 반영

| # | 지점 | 판정 | 처분 |
|---|---|---|---|
| 1 | config.json 신뢰 소스 | **깨짐(Critical)** — 경고≠차단·gitignore 어휘검사=거짓 음성(`git add -f`) | ✅ 저장을 `~/.gbc/verify-run.json`으로 이전(벡터 구조적 소멸) |
| 2 | shell:true+inherit | 버팀 | ✅ 실행 전 명령+소스 에코 · kill 트리 한계 문서화 |
| 3 | exit 비게이트/XML 판정 | **깨짐(Medium)** — provenance unknown 갭(standalone)에서 옛 XML verified | ✅ run-start mtime 검사(spawn 직전 시각을 lastEditAt 주입) |
| 4 | --save | 1에 흡수 | ✅ save 시 1줄 고지 |
| 5 | 비목표 봉인 | 버팀 | ✅ "필터는 명령 리터럴에 pin" 배출구 명시 |
| 6 | 누락 벡터 | 2건 | ✅ allowlist confused-deputy 위협모델 행+README 명기 · 재귀 가드 GBC_RUN_ACTIVE |

초안의 ".gitignore 어휘 경고" 방어는 **기각됨**(위 #1) — 본문 3·4절은 반영 후 상태.
