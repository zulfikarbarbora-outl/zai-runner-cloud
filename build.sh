#!/bin/bash
# Netlify cloud-build lane: z.ai signup runs ON the Netlify build machine.
# v3 2026-10-13: creds egress via GIT PUSH (git is disk — the S22 design);
# run.log committed too; diagnostics for the 799-byte-log mystery.
echo "[build] z.ai cloud signup starting at $(date -u)"
mkdir -p dist /tmp/zaiout
echo "[build] node $(node -v) npm $(npm -v) | disk: $(df -h / | tail -1 | awk '{print $4}') free"
cd runner
echo "[build] npm install..."
npm install --no-audit --no-fund 2>&1 | tail -3
echo "[build] chromium install (headless shell only — smaller)..."
npx playwright install chromium 2>&1 | tail -3
echo "[build] apt deps (sudo)..."
sudo apt-get update -qq 2>&1 | tail -1
sudo apt-get install -y -qq libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libatspi2.0-0 libxdamage1 libgbm1 libpango-1.0-0 libcairo2 libasound2 2>&1 | tail -2
npx playwright install chromium 2>&1 | tail -2
ls /opt/buildhome/.cache/ms-playwright/ 2>/dev/null || true
echo "[build] running signup (runner v2 full chain)..."
node zai_signup_gha.js --email-domain "${MAIL_DOMAIN:-priv.email}" --outdir /tmp/zaiout 2>&1 | tee /tmp/zaiout/run.log
rc=${PIPESTATUS[0]}
echo "[build] runner exit=$rc"
cd ..
cp /tmp/zaiout/run.log dist/ 2>/dev/null || echo "no log" > dist/run.log
for f in /tmp/zaiout/zai-*.json; do
  [ -e "$f" ] && cp "$f" dist/ && echo "[build] creds staged: $f"
done
echo "<html><body><pre>$(head -c 30000 dist/run.log)</pre></body></html>" > dist/index.html

# --- git egress: commit creds + log back to the repo (S22 design) ---
if [ -n "$GH_PAT" ] && [ -n "$(ls /tmp/zaiout/zai-*.json 2>/dev/null)" ]; then
  echo "[build] pushing creds via git..."
  git config user.email "runner@netlify-build" && git config user.name "zai-cloud-runner"
  git remote set-url origin "https://$GH_PAT@github.com/zulfikarbarbora-outl/zai-runner-cloud.git" 2>/dev/null || git remote add origin "https://$GH_PAT@github.com/zulfikarbarbora-outl/zai-runner-cloud.git"
  mkdir -p creds && cp /tmp/zaiout/zai-*.json creds/ && cp /tmp/zaiout/run.log creds/last-run.log
  git add creds dist 2>/dev/null
  git commit -qm "cloud-run: creds + log $(date -u +%Y%m%dT%H%M%SZ) rc=$rc" 2>/dev/null
  git push origin HEAD:refs/heads/runs 2>&1 | tail -2
else
  echo "[build] no creds or no GH_PAT — skipping git egress (rc=$rc)"
  # still push the log for debugging
  if [ -n "$GH_PAT" ]; then
    git config user.email "runner@netlify-build" && git config user.name "zai-cloud-runner"
    git remote set-url origin "https://$GH_PAT@github.com/zulfikarbarbora-outl/zai-runner-cloud.git" 2>/dev/null || git remote add origin "https://$GH_PAT@github.com/zulfikarbarbora-outl/zai-runner-cloud.git"
    mkdir -p creds && cp /tmp/zaiout/run.log creds/last-run.log 2>/dev/null
    git add creds 2>/dev/null && git commit -qm "cloud-run: log only $(date -u +%Y%m%dT%H%M%SZ) rc=$rc" 2>/dev/null && git push origin HEAD:refs/heads/runs 2>&1 | tail -2
  fi
fi
exit 0
