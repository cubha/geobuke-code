# VERIFY-IMPL — 0.13.1「잔여 종결」인수검증 + 런타임 실증

일시: 2026-08-26 · 브랜치: `feature/silver_sh`(미커밋) · 기준선: `docs/plan/PLAN-0.13.1-residual-closeout.md`

두 축으로 검증했다. **축A**는 기준선 대비 정적 코드 대조(독립 컨텍스트 `acceptance-critic`),
**축B**는 시안이 없는 CLI/TUI 프로젝트라 브라우저 대조 대신 **실제 구동 실증**으로 대체했다.
실증은 전부 `dist/`(방금 빌드) 프로덕션 산출물을 실 진입점으로 돌린 결과다.

---

## 축A — 요구사항·계획 대비 코드

`acceptance-critic` 독립 판정: **UNMET 0 · UNREQUESTED 0**.

ST1~ST10 전 항목 ✅충족, 하드 제약 4건(판정입력 불변 · 테스트 약화 금지 · `card` 필수 nullable ·
redaction 적용 지점 · `beforeHash` 순서)도 전부 충족. 계획에 없던 미요청 구현 0건.

축A의 자기 고지 한계: 정적 대조라 tmux 실렌더·게이트 런타임 동작은 문서 자기보고에 의존했다.
**아래 축B가 정확히 그 부분을 실측으로 메운다.**

---

## 축B — 런타임 실증 (정·역 대조)

게이트 실증은 **격리 스크래치 repo**(`HOME`·`USERPROFILE` 오버라이드, 인증 끊김으로 인한 fail-open
오측정을 막기 위해 fakehome에 키 심음 — 0.5.2 실측 함정)에서 수행했다.

TUI 실증(실증7~11)만은 실제 TUI를 본 repo에서 띄워야 해서 본 repo에서 돌렸다. **오염 여부를 사후
확인**: 해당 시각대(`10:2x~10:3xZ`)에 이 repo `.gbc/events.jsonl`에 게이트 이벤트가 **0건**이다
(중단된 턴은 도구 호출 없음, 승인 턴은 거부로 종결). 이 배치 자신의 M-1 규율(관측 오염 방지)을
그대로 적용한 결과다.

### 실증1 — 실 PreToolUse hook이 진짜 block 레코드를 만든다 (시딩의 형상 계약)

`gbc spec add` 2건 → 두 케이스 어느 것도 다루지 않는 편집으로 실 hook 호출:

```
decision=block · missing=[케이스 A, 케이스 B] · pending-review.json 생성(seen 포함)
```

이후 모든 실증의 입력은 **이 실 hook 산출물**이다(합성 입력 아님 —
`feedback_regression_input_shape_contract` 계열 3회 반복 회피).

### 실증2 — ST3 Critical: 원소 손상 시 게이트 생존 (정·역)

실 hook이 만든 레코드의 `seen` 배열에 숫자 원소 하나(`42`)를 주입 = 컨테이너는 배열, 원소만 손상.

| | 결과 |
|---|---|
| **현행(수정 후)** | `decision=block-repeat`(`repeatMatch:exact`) · **failopen.log 없음** — 게이트 정상 발화 |
| **음성대조(수정 전 가드로 되돌림)** | `TypeError: item.trim is not a function` → **fail-open** · `failopen.log` 1건 · **gate 이벤트 자체가 없음** · permissionDecision 부재 = 편집 무검사 통과 |

음성대조는 `dist/review.js`의 원소검사를 `Array.isArray(v)`(0.6.1 R3 시절 형상)로 되돌려 재현했고
측정 후 원복했다. 즉 **이 가드가 없으면 게이트가 실제로 뚫린다**는 것이 재현된 사실이다.

**자가치유 부재도 실측**: 크래시 후 손상 레코드가 그대로 잔존했다(덮어쓸 `effects.pendingReview`
기록이 크래시 지점보다 뒤라, 같은 작업단위 내내 반복 누출).

> 정정 1건 — 이전 세션에서 이 결함을 "**조용히** 뚫린다"고 적었으나, 실측에서는 fail-open 배너와
> `failopen.log`가 남는다. 관측 흔적은 있다. 뚫린다는 사실 자체는 그대로다.

### 실증3 — worst case: `missing`·`seen` 동시 손상

`missing`에 객체, `seen`에 null 동시 주입 → **fail-open 없이 일반 `block`으로 떨어짐**(레코드째
폐기 → 재발화 억제만 사라지고 차단은 유지 = 더 엄격한 방향). 설계 의도대로다.

### 실증4 — ST2 `gbc done` 부수효과 (정·역)

실 `gbc done` CLI 구동:

| | spec.md | pending-review.json | applied.json | 아카이브 |
|---|---|---|---|---|
| 직전 | 2케이스 | 존재 | 존재(실 PostToolUse hook 산출) | — |
| **직후** | 0바이트 | **삭제** | **삭제** | `5cc4a9f…-2026-08-26T09-13-35Z.md` |

아카이브 파일명 해시가 done 직전 specHash와 일치 = `beforeHash` 캡처가 `archiveSpec`보다 먼저라는
순서 불변식의 런타임 증거.

**음성대조**: `closeWorkUnit`에서 `clearPendingReview` 호출만 제거한 판본으로 같은 절차를 돌리면
`pending-review.json`이 **잔존**했다(옛 결함 재현). 이 SubTask의 효과는 인과적으로 확인됐다.

### 실증5 — ST7 lock 드리프트 가드 (정·역)

| | 결과 |
|---|---|
| 현행 | `ok 1` — 통과 |
| `package.json` version만 0.13.1로 손편집 | `not ok 1` — "package-lock.json 최상위 version이 package.json과 어긋났다" |

**발행 시 함의**: bump를 손으로 하면 이 가드에 걸린다. `npm version --no-git-tag-version` 사용 필수.

### 실증6 — ST4 크래시 덤프 redaction (엔트리 경계 걸친 PEM)

실 `formatCrashDump`에 스크롤백 엔트리 8개(단일행 API 키 · Bearer 토큰 · **4개 엔트리에 걸쳐 쪼개진
PEM 블록** · spinner 1건) 투입:

```
ANTHROPIC_API_KEY=[REDACTED]
[REDACTED]                      ← PEM 4엔트리가 통째로 1건으로 마스킹
Authorization: Bearer [REDACTED]
```

누출 0 · 헤더 형식 보존 ✅ · 멱등성 ✅. **join 후 1회 적용**이 아니면 못 잡는 케이스가 실제로
잡혔다.

### 실증7~9 — ST5 키맵 레지스트리 (tmux 80×24 · 100×40 실렌더)

전용 소켓(`tmux -L gbcv -f /dev/null`) 격리, 세션 생성 후 `resize-window`(프로젝트 CLAUDE.md 규칙).

- 레지스트리 15항목 · `card≠null` 10항목 · 도움말 15행
- **카드 실렌더 ≡ 레지스트리**(5행, 순서·문구 완전일치, 기계 대조)
- `card=null` 5항목(`Alt+1..9`·`Alt+W`·`Tab`·`/`·`!cmd`)이 카드로 새지 않음
- `?` 키 실입력 → 도움말 패널이 실제로 열리고 15항목 전량 노출("▼ 아래 5개" 포함)
- 80×24 ↔ 100×40 두 크기에서 카드 5행 동일

### 실증10 — ST6a/ST6b 턴시간 + outcome (실 턴 → Esc 중단)

TUI에서 실제 프롬프트를 제출해 엔진이 스트리밍하는 중 `Esc`로 중단:

```
[Request interrupted by user]  ·  🐢 중단됨 — 응답 생성을 취소했습니다
상태줄: … · $0.00 · 8.8s 중단 · 25.1k
```

- **`8.8s 중단`** — 접미 표기가 살아있는 화면에서 확인됨
- **토큰(`25.1k`)이 여전히 맨 끝** — 좁은 폭 강등 우선순위 불변식이 실렌더에서 유지

> 중간 오판 정정: 폭 100에서는 턴시간이 안 보여 배선 결함을 의심했으나, 폭 170으로 넓히자 나타났다.
> **상태줄 꼬리가 설계대로 잘렸던 것**이지 미배선이 아니다(`height=1·overflow hidden`, 코드 주석
> "넘치는 꼬리는 잘리는 게 프레임 밀림보다 낫다").

### 실증11 — ST6b 승인대기 차감 (T-2의 실제 요구사항)

실증10은 승인 프롬프트가 없는 턴이라 `approvalWaitMs=0`이었다 — **`중단` 접미와 클램프 순서만**
증명하고, T-2가 실제로 요구한 *"턴시간 의미 정정 = 사람 승인대기를 뺀다"*는 미관측이었다(ST6b는
TDD 부적격이라 누적 경로에 테스트가 없다). 그래서 별도로 승인을 강제해 실측했다.

게이트가 ask를 내는 Write를 유도(스크래치 경로 대상)해 `🐢 승인 대기` 박스를 띄우고 **고의로 오래
방치한 뒤** `n`(거부)으로 응답:

| | 값 |
|---|---|
| 제출 → 응답 실경과 | **45.7s** |
| 턴 전체 wall clock | **≈47.2s** |
| 상태줄 보고 턴시간 | **6.7s** |
| 차감된 몫 | **40.5s** ≈ 승인대기 구간 |

**대조군**(같은 세션 직전 턴, 승인 없는 Bash 실행): 보고 `12.7s` ≈ wall clock — 뺄 승인대기가
없으니 차감도 없다. 두 턴의 대비가 차감 경로가 실제로 도는 증거다(고장이라면 둘 다 wall clock과
같아야 한다).

부수 확인: 거부(`n`)가 반영돼 대상 파일이 생성되지 않았다.

### 실증12 — M-1 `appliedStale` 재관측 (ST10)

이전 세션 자기보고에 기대지 않도록 이번 세션에서 다시 측정했다. 실 PostToolUse hook으로 원장을
만들고(`x.ts` 구현 기록), 같은 편집을 두 조건에서 실 PreToolUse hook에 태웠다:

| 조건 | 이벤트 |
|---|---|
| 원장 생존(`x.ts` 앵커 있음) | `decision=pass` · **`appliedCount:1`** |
| **`x.ts` 구현 삭제 후 동일 편집** | `decision=pass` · **`appliedStale:1`** · `appliedCount` 소멸 |

0.12.4 Critical 수정(원장 엔트리 생존 재검증)이 실제로 발화해 **낡은 엔트리가 탈락**했다.

> 정직 고지: 이전 세션에서는 이 조건에서 판정이 `block`으로 **뒤집히는 것**까지 관측됐으나, 이번
> 재관측에서는 `pass`가 유지됐다(LLM 판정의 비결정성 — y.ts 편집 자체를 충분하다고 봄). 결정론적
> 관측 대상인 `appliedStale:1`은 두 세션 모두 재현됐다.

---

## 최종 게이트

| 항목 | 결과 |
|---|---|
| `npm test` | **1244 / 1244** (fail 0 · skip 0) |
| eval hard | **22/22** · TP=14 TN=8 **FP=0 FN=0** · baseline 유지 |
| scope 회귀 | **6/6** |
| `bash verify.sh --eval` | ✅ Verification passed |

---

## 배치 범위 밖 관측 1건 (수정하지 않음)

상태줄 2행에 **빈 세그먼트**가 보인다(`… feature/silver_sh* ·  · ▱▱…`). 원인은 첫 턴 전
`data.model`이 빈 문자열이라 세그먼트가 빈 채로 렌더되는 것. `git diff`로 확인한 결과 이번 배치는
세그먼트 배열을 **건드리지 않았다**(변경은 turn suffix 1줄뿐) = 0.13.1 회귀가 아닌 기존 동작.
판정 입력 무관·미관측 잔여로 기록만 남긴다.

---

## 결론

**기준선 충족** — UNMET 0 · UNREQUESTED 0.

정적 대조(축A)와 런타임 실증(축B)이 어긋난 항목은 없다. 특히 이 배치의 핵심인 ST3 Critical과
ST2·ST7·ST6b는 **음성대조/대조군까지 붙여** 효과를 인과적으로 입증했다(수정을 제거하면 결함이
재현되고, 되돌리면 사라진다).

**축B 커버리지 명세**(무엇이 실측이고 무엇이 아닌지):

| SubTask | 런타임 실측 | 비고 |
|---|---|---|
| ST2·ST3·ST4·ST7·ST10 | ✅ 정·역 대조 | 실 hook·실 CLI·실 모듈 |
| ST5 | ✅ 두 크기 실렌더 + 레지스트리 기계 대조 | |
| ST6a·ST6b | ✅ 실 턴 2건(중단 · 승인대기) | 접미·클램프순서·차감 전부 관측 |
| ST1·ST8·ST9 | — 문서/조사라 런타임 대상 없음 | 축A 정적 대조로 충족 |

이 배치에서 **런타임 근거 없이 코드 독해에만 기대는 항목은 남아있지 않다.**
