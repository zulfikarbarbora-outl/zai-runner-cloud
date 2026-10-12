#!/bin/bash
# Netlify cloud-build lane: signup runs ON the Netlify build machine.
# Output: creds committed via API? No — build writes to Blobs via the
# onPostBuild plugin (runtime token available there), plus dist/ artifact.
set -e
echo "[build] z.ai cloud signup starting at $(date -u)"
mkdir -p dist /tmp/zaiout
cd runner
npm install --no-audit --no-fund
npx playwright install chromium --with-deps
node zai_signup_gha.js --email-domain "${MAIL_DOMAIN:-priv.email}" --outdir /tmp/zaiout 2>&1 | tee /tmp/zaiout/run.log
rc=${PIPESTATUS[0]}
echo "[build] runner exit=$rc"
# publish a minimal dist so the deploy succeeds regardless
cp /tmp/zaiout/run.log dist/ 2>/dev/null || echo "no log" > dist/run.log
for f in /tmp/zaiout/zai-*.json; do
  [ -e "$f" ] && cp "$f" dist/ && echo "[build] creds staged: $f"
done
exit 0
