#!/bin/bash
set -e

echo "🔍 Verifying geobuke-code..."

# TypeScript 빌드
echo "📦 Building..."
npm run build

# 테스트 실행
echo "🧪 Running tests..."
npm test

echo "✅ Verification passed"
exit 0
