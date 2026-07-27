#!/bin/bash
set -e

# 사용: bash verify.sh [--no-build]
#   --no-build : 빌드 건너뜀 (테스트만) — SubTask 단위 fast gate (F-NEW-26)
NO_BUILD=false
for arg in "$@"; do
  case $arg in
    --no-build) NO_BUILD=true ;;
  esac
done

# ─── 행(hang) 가드 러너 (F-NEW-33) ────────────────────────────
# 장시간 명령은 $() 캡처 금지 + timeout 필수. 근거: 명령이 정상 종료해도 고아 자식이
# stdout을 물면 셸이 계속 블록되고(실측 6002ms·exit=0) timeout조차 발동하지 않는다.
# `--foreground` 금지 — 그룹 킬이 꺼져 고아가 무한 대기한다(≥58s 관측).
VERIFY_LOG_DIR="${TMPDIR:-/tmp}/verify-geobuke-code-$$"
mkdir -p "$VERIFY_LOG_DIR"
VERIFY_TIMEOUT_TEST=${VERIFY_TIMEOUT_TEST:-240}
VERIFY_TIMEOUT_BUILD=${VERIFY_TIMEOUT_BUILD:-600}

run_guarded() {
  local secs="$1" logname="$2"; shift 2
  local log="$VERIFY_LOG_DIR/$logname" rc=0 wd=""
  # 동결 시점 스냅샷 — timeout 그룹 킬이 증거를 지우기 전에 촬영. 서브셸 출력은 반드시 닫는다
  # (상위가 verify.sh를 $()로 캡처할 때 워치독이 파이프를 물면 우리가 그 행을 만든다).
  ( sleep $(( secs * 2 / 3 )); ps -ef --forest > "$VERIFY_LOG_DIR/freeze-$logname" 2>/dev/null ) >/dev/null 2>&1 &
  wd=$!
  timeout --kill-after=15 "$secs" "$@" > "$log" 2>&1 || rc=$?
  kill "$wd" 2>/dev/null || true; wait "$wd" 2>/dev/null || true
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo "❌ 행(hang) 감지: '$*' 이 ${secs}초 내 미종료 (exit $rc)"
    {
      echo "=== 명령: $* (상한 ${secs}s, exit $rc)"
      echo "=== 동결 시점 프로세스 트리 ==="
      cat "$VERIFY_LOG_DIR/freeze-$logname" 2>/dev/null || echo "(스냅샷 없음)"
      echo "=== 그룹 킬 생존자 ==="
      ps -ef --forest 2>/dev/null | grep -E 'esbuild|vite|vitest|jest|tsserver|prisma' | grep -v grep || echo "(없음)"
      echo "=== 로그 마지막 50줄 ==="
      tail -50 "$log" 2>/dev/null
    } > "$VERIFY_LOG_DIR/forensic-$logname" 2>&1
    echo "   포렌식 덤프: $VERIFY_LOG_DIR/forensic-$logname"
  fi
  return "$rc"
}

echo "🔍 Verifying geobuke-code..."

# TypeScript 빌드
if [ "$NO_BUILD" = false ]; then
  echo "📦 Building..."
  BUILD_EXIT=0
  run_guarded "$VERIFY_TIMEOUT_BUILD" build.log npm run build || BUILD_EXIT=$?
  if [ "$BUILD_EXIT" -ne 0 ]; then
    tail -30 "$VERIFY_LOG_DIR/build.log"
    echo "❌ 빌드 실패 (exit $BUILD_EXIT)"
    exit 1
  fi
else
  echo "⏭️  빌드 건너뜀 (--no-build) — 풀 빌드는 COMPLETE/ship 게이트에서 실행"
fi

# 테스트 실행
echo "🧪 Running tests..."
TEST_EXIT=0
run_guarded "$VERIFY_TIMEOUT_TEST" test.log npm test || TEST_EXIT=$?
if [ "$TEST_EXIT" -ne 0 ]; then
  tail -30 "$VERIFY_LOG_DIR/test.log"
  echo "❌ 테스트 실패 (exit $TEST_EXIT)"
  exit 1
fi
cat "$VERIFY_LOG_DIR/test.log"

echo "✅ Verification passed"
rm -rf "${VERIFY_LOG_DIR:?}"   # 통과분 로그는 누적만 됨 (실패·행일 때만 보존)
exit 0
