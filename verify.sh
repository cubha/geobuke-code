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

echo "🔍 Verifying geobuke-code..."

# TypeScript 빌드
if [ "$NO_BUILD" = false ]; then
  echo "📦 Building..."
  npm run build
else
  echo "⏭️  빌드 건너뜀 (--no-build) — 풀 빌드는 COMPLETE/ship 게이트에서 실행"
fi

# 테스트 실행
echo "🧪 Running tests..."
npm test

echo "✅ Verification passed"
exit 0
