#!/usr/bin/env bash
set -e

# Ensure we run from the repo root regardless of where the script is called from
cd "$(dirname "$0")"

echo "Setting up agentic-feedback..."
npm install --silent
npm run build --silent
npm link --silent
echo "Ready."

exec node dist/tui/index.js
