#!/bin/bash
# Netlify cloud-build lane: z.ai signup runs ON the Netlify build machine.
# v2 2026-10-13: runner v2 (finish_signup fix); no set -e (every step
# logs, the log always deploys so we can diagnose from the deploy URL);
# creds -> dist/ + Blobs (onPostBuild plugin).
echo "[build] z.ai cloud signup starting at $(date -u)"
mkdir -p dist /tmp/zaiout
cd runner
echo "[build] npm install..."
npm install --no-audit --no-fund 2>&1 | tail -2
echo "[build] chromium install..."
npx playwright install chromium --with-deps 2>&1 | tail -3
echo "[build] running signup (runner v2)..."
node zai_signup_gha.js --email-domain "${MAIL_DOMAIN:-priv.email}" --outdir /tmp/zaiout 2>&1 | tee /tmp/zaiout/run.log
rc=${PIPESTATUS[0]}
echo "[build] runner exit=$rc"
cd ..
cp /tmp/zaiout/run.log dist/ 2>/dev/null || echo "no log" > dist/run.log
for f in /tmp/zaiout/zai-*.json; do
  [ -e "$f" ] && cp "$f" dist/ && echo "[build] creds staged: $f"
done
echo "<html><body><pre>$(cat dist/run.log | head -c 30000)</pre></body></html>" > dist/index.html
exit 0
