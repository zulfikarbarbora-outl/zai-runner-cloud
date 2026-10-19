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
# S26+: fetch existing runs branch first so the push is fast-forward
# (the runs branch diverged from main after Oct 13; HEAD:runs is now
# non-fast-forward and gets rejected. Fetch + commit-on-top fixes it.)
egress_push() {
  local label="$1"
  if [ -z "$GH_PAT" ]; then
    echo "[build] no GH_PAT — skipping git egress"
    return
  fi
  git config user.email "runner@netlify-build" && git config user.name "zai-cloud-runner"
  git remote set-url origin "https://$GH_PAT@github.com/zulfikarbarbora-outl/zai-runner-cloud.git" 2>/dev/null || git remote add origin "https://$GH_PAT@github.com/zulfikarbarbora-outl/zai-runner-cloud.git"
  # fetch existing runs branch (if any) so we can commit on top
  git fetch origin refs/heads/runs:refs/heads/runs 2>/dev/null || true
  # stage the creds + log
  mkdir -p creds
  cp /tmp/zaiout/zai-*.json creds/ 2>/dev/null || true
  cp /tmp/zaiout/run.log creds/last-run.log 2>/dev/null || true
  # WAVE-12: the working tree is dirty (dist/ was built). Stash before checkout.
  git stash 2>/dev/null || true
  # create the commit on the runs branch (checkout if exists, else create)
  if git show-ref --verify --quiet refs/heads/runs; then
    git checkout runs 2>/dev/null || true
  else
    git checkout -b runs 2>/dev/null || true
  fi
  # copy creds again (stash may have reverted the creds/ dir)
  mkdir -p creds
  cp /tmp/zaiout/zai-*.json creds/ 2>/dev/null || true
  cp /tmp/zaiout/run.log creds/last-run.log 2>/dev/null || true
  git add creds 2>/dev/null
  if git diff --cached --quiet; then
    echo "[build] nothing to commit (creds unchanged)"
  else
    git commit -qm "cloud-run: ${label} $(date -u +%Y%m%dT%H%M%SZ) rc=$rc" 2>/dev/null
    git push origin runs:refs/heads/runs 2>&1 | tail -3
  fi
  # return to main + restore stashed changes
  git checkout main 2>/dev/null || true
  git stash pop 2>/dev/null || true
}

if [ -n "$(ls /tmp/zaiout/zai-*.json 2>/dev/null)" ]; then
  echo "[build] pushing creds via git..."
  egress_push "creds + log"
else
  echo "[build] no creds produced (rc=$rc) — pushing log only"
  egress_push "log only"
fi
exit 0
