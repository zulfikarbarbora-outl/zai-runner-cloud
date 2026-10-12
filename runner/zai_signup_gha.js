#!/usr/bin/env node
/* zai_signup_gha.js — z.ai account factory runner (self-contained).
 *
 * Runs the FULL chain from a fresh IP (GHA runner / any linux box):
 *   1. signup: form + Aliyun slide captcha (proven solver) → POST /auths/signup
 *   2. verify: poll the mail API → open verify link → complete set-password
 *      (the step account #9 missed — verify alone leaves the account
 *      passwordless; signin then 400s "email or password incorrect")
 *   3. signin: UI flow + captcha round → token cookie session
 *   4. api key: POST /api/v1/auths/api_key (the tail — so we never need
 *      the browser again)
 *   5. output: creds JSON to outdir + stdout (workflow commits it)
 *
 * Mail: v3-mail API (both priv.email apex ~7s and v3-mail.priv.email ~11s
 * are z.ai-accepted + readable). Domain from --email-domain or DOMAIN env.
 *
 * Usage: node zai_signup_gha.js [--email-domain priv.email] [--outdir ./out]
 * Exit codes: 0 ok | 4 form/widget missing | 5 captcha fail | 6 mail timeout
 *             7 exception | 8 signin failed | 9 api-key failed
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).map((s, i, a) =>
  s.startsWith('--') ? [s.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true] : []));
const OUTDIR = args.outdir || process.env.OUTDIR || './out';
fs.mkdirSync(OUTDIR, { recursive: true });

// solver core (from onboard-automation-common — provides log, sleep,
// launchLocal, popupState, dumpPopup, solveWidget, widgetNeedsStart,
// formReport, clickFirst, detectGap, humanDrag, livePositions)
global.OUTDIR = OUTDIR;
global.chromium = chromium;   // the core's launchLocal needs it
global.fs = fs;               // the core's dumpPopup/solveWidget need it
require('./_solver_core.js');

const MAIL_DOMAIN = args['email-domain'] || process.env.DOMAIN || 'priv.email';
const MAIL_API_BASE = process.env.MAIL_API_BASE || 'https://v3-mail.priv.email';
const MAIL_API_TOKEN = process.env.MAIL_API_TOKEN; // set via Netlify env / GHA secrets
const RUN_TAG = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const apiLog = [];
function watchApi(page) {
  page.on('response', async (res) => {
    if (/aliyun|alicdn/i.test(res.url()) && /captcha-open|verify/.test(res.url()) && !/\.(js|css|png|woff)/.test(res.url())) {
      let body = '';
      try { body = (await res.text()).slice(0, 400); } catch {}
      const verif = (body.match(/"Verifica(?:tion|tionResult)"\s*:\s*"?([A-Za-z0-9]+)"?/) || [])[1];
      log('aliyun', `→ ${res.status()} verify=${verif || '-'} ${body.replace(/\n/g, ' ').slice(0, 150)}`);
    }
    if (/\/api\/v1\/auths\//.test(res.url())) {
      let body = '';
      try { body = (await res.text()).slice(0, 400); } catch {}
      apiLog.push({ url: res.url().split('?')[0], status: res.status(), body });
      log('api', `${res.request().method()} …${res.url().split('?')[0].slice(-40)} → ${res.status()} ${body.slice(0, 130).replace(/\n/g, ' ')}`);
    }
  });
}

/* ---------------- mail ---------------- */
async function mailList(email) {
  const r = await fetch(`${MAIL_API_BASE}/emails?address=${encodeURIComponent(email)}&limit=20&include_body=true`,
    { headers: { Authorization: `Bearer ${MAIL_API_TOKEN}`, Accept: 'application/json' } });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return await r.json();
}
async function pollMailLink(email, deadlineMs, filter) {
  const deadline = Date.now() + deadlineMs;
  const seen = new Set();
  while (Date.now() < deadline) {
    const d = await mailList(email);
    for (const row of (d && d.results) || []) {
      const key = row.id || row.message_id;
      if (seen.has(key)) continue;
      seen.add(key);
      const subj = row.subject || '';
      if (filter && !filter.test(subj)) continue;
      const body = row.text_body || '';
      const m = (body.match(/https?:\/\/[^\s"']*chat\.z\.ai[^\s"']*/i) || [])[0];
      if (m) return { link: m, subject: subj };
    }
    await sleep(6000);
  }
  return { link: null, subject: 'timeout' };
}

/* ---------------- session helpers ---------------- */
async function sessionUser(page) {
  return page.evaluate(async () => {
    const r = await fetch('/api/v1/auths/', { credentials: 'include' });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, id: j && j.id, email: j && j.email, role: j && j.role, name: j && j.name };
  }).catch((e) => ({ err: e.message }));
}
function isGuest(u) { return !u || u.err || !u.id || /guest/i.test(u.email || ''); }

async function cookiesOf(ctx) {
  const cookies = {};
  for (const c of await ctx.cookies('https://chat.z.ai')) cookies[c.name] = c.value;
  return cookies;
}

/* ---------------- the login form + captcha + submit (shared) -----------
 * Navigates the email form, fills creds, solves the widget, clicks submit.
 * usedBy: 'signin' | 'forgot' (label only — the form is identical)
 */
async function emailFormSubmit(page, { email, password, submitLabel }) {
  await clickFirst(page, ['text=Continue with Email', 'button:has-text("Continue with Email")'], 'email entry');
  await sleep(2500);
  for (const [sel, val] of [
    ['input[type="email"]', email], ['input[name="email"]', email],
    ['input[type="password"]', password], ['input[name="current-password"]', password],
  ]) {
    const loc = page.locator(sel).first();
    try { if (await loc.count() && await loc.isVisible()) { await loc.fill(val, { timeout: 3000 }); log('fill', sel); } } catch {}
  }
  const started = await clickFirst(page,
    ['text=Click to start verification', 'button:has-text("Click to start verification")', '#aliyunCaptcha-captcha-text'], 'widget start');
  if (!started) return false;
  for (let i = 0; i < 15; i++) {
    const ready = await page.evaluate(() => {
      const img = document.querySelector('#aliyunCaptcha-img');
      const pc = document.querySelector('#aliyunCaptcha-puzzle');
      return !!(img && img.src && pc);
    }).catch(() => false);
    if (ready) break;
    await sleep(2000);
  }
  await sleep(1200);
  const solved = await solveWidget(page);
  log('captcha', `${submitLabel} captcha solved=${solved}`);
  if (!solved) return false;
  await sleep(800);
  const clicked = await clickFirst(page,
    [`button:has-text("${submitLabel}")`, 'button[type="submit"]'], submitLabel);
  await sleep(6000);
  return clicked;
}

/* ---------------- main ---------------- */
(async () => {
  log('start', `domain=${MAIL_DOMAIN} outdir=${OUTDIR} ip-check...`);
  try { const r = await fetch('https://api.ipify.org'); log('ip', await r.text()); } catch {}

  const email = `zs-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 8)}@${MAIL_DOMAIN}`;
  const password = `Zk${Math.random().toString(36).slice(2, 8)}!${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const name = 'Zed Walker';
  log('id', `email=${email} password=${password}`);
  fs.writeFileSync(`${OUTDIR}/identity.json`, JSON.stringify({ email, password, name, domain: MAIL_DOMAIN }, null, 2));

  const browser = await launchLocal();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-US',
  });
  const page = await ctx.newPage();
  watchApi(page);

  try {
    /* ---- phase 1: signup ---- */
    await page.goto('https://chat.z.ai/auth', { timeout: 60000, waitUntil: 'domcontentloaded' });
    for (let h = 0; h < 15; h++) { const n = await page.locator('button').count().catch(() => 0); if (n >= 2) break; await sleep(2000); }
    log('nav', `title="${await page.title()}"`);

    // login form → fill email+password (form starts in LOGIN mode)
    await clickFirst(page, ['text=Continue with Email', 'button:has-text("Continue with Email")'], 'email entry');
    await sleep(2500);
    for (const [sel, val] of [
      ['input[type="email"]', email], ['input[name="email"]', email],
      ['input[type="password"]', password], ['input[name="password"]', password], ['input[name="current-password"]', password],
    ]) {
      const loc = page.locator(sel).first();
      try { if (await loc.count() && await loc.isVisible()) { await loc.fill(val, { timeout: 3000 }); log('fill', `${sel}`); } } catch {}
    }

    // captcha round 1 on the login-mode form
    let started = await clickFirst(page,
      ['text=Click to start verification', 'button:has-text("Click to start verification")', '#aliyunCaptcha-captcha-text'], 'widget start');
    if (!started) { await browser.close(); process.exit(4); }
    for (let i = 0; i < 15; i++) {
      const ready = await page.evaluate(() => {
        const img = document.querySelector('#aliyunCaptcha-img');
        const pc = document.querySelector('#aliyunCaptcha-puzzle');
        return !!(img && img.src && pc);
      }).catch(() => false);
      if (ready) break;
      await sleep(2000);
    }
    if (!await solveWidget(page)) { await browser.close(); process.exit(5); }

    // "Sign up" morphs the form (Name appears, email/pw carry, captcha resets)
    await sleep(1200);
    await clickFirst(page, ['button:has-text("Sign up")', 'text=Sign up'], 'signup switch');
    for (let i = 0; i < 12; i++) {
      const fr = await formReport(page);
      const hasName = (fr.inputs || []).some((x) => /name/i.test(`${x.ph || ''}${x.name || ''}`) && !/email/i.test(x.ph || ''));
      if (hasName) break;
      await sleep(1200);
    }
    for (const [sel, val] of [
      ['input[placeholder*="Full Name" i]', name], ['input[placeholder*="name" i]', name],
      ['input[name="name"]', name], ['input#name', name], ['input[autocomplete="name"]', name],
    ]) {
      const loc = page.locator(sel).first();
      try { if (await loc.count() && await loc.isVisible()) { await loc.fill(val, { timeout: 3000 }); log('fill', `name via ${sel}`); break; } } catch {}
    }
    const carry = await page.evaluate(() => {
      const g = (sel) => { const el = document.querySelector(sel); return el ? el.value : ''; };
      return { email: g('input[type="email"]'), pwLen: g('input[type="password"]').length };
    });
    if (!carry.email) { const loc = page.locator('input[type="email"]').first(); try { await loc.fill(email, { timeout: 3000 }); } catch {} }
    if (!carry.pwLen) { const loc = page.locator('input[type="password"]').first(); try { await loc.fill(password, { timeout: 3000 }); } catch {} }

    // captcha round 2 on the morphed form — the widget ALWAYS resets here
    // (empirically 2026-10-12 GHA: needs-start check races the morph, the
    // widget shows "Click to start verification" while the check says
    // verified → Create Account clicks into a blocked form, no POST).
    // So: unconditionally try to start + solve; only skip when the widget
    // is genuinely absent.
    await sleep(2500);
    let round2Solved = false;
    const okStart2 = await clickFirst(page,
      ['text=Click to start verification', 'button:has-text("Click to start verification")', '#aliyunCaptcha-captcha-text', '#aliyunCaptcha-captcha-left'], 'widget start 2');
    if (okStart2) {
      for (let i = 0; i < 15; i++) {
        const s = await popupState(page);
        if (s.present && s.img && s.img.srcLen > 500) break;
        await sleep(2000);
      }
      round2Solved = await solveWidget(page);
      log('captcha', `round 2 solved=${round2Solved}`);
      if (!round2Solved) { await browser.close(); process.exit(5); }
    } else {
      // widget may already be verified (rare) — verify by popup absence
      const st = await popupState(page);
      log('captcha', `round 2: no start control (popup present=${st.present}) — assuming verified`);
    }

    // Create Account — verify the signup POST actually fired; retry clicks
    await sleep(1200);
    for (let clickN = 1; clickN <= 3; clickN++) {
      const firedBefore = apiLog.filter((a) => /auths\/signup$/.test(a.url) && a.status === 200).length;
      await clickFirst(page, ['button:has-text("Create Account")', 'button:has-text("Create")'], 'create account');
      await sleep(8000);
      const fired = apiLog.filter((a) => /auths\/signup$/.test(a.url) && a.status === 200).length;
      log('signup', `click ${clickN}: signup-200 count ${firedBefore} -> ${fired}`);
      if (fired > firedBefore) break;
      // if the widget reset again (button disabled), re-solve
      const restart = await clickFirst(page,
        ['text=Click to start verification', '#aliyunCaptcha-captcha-text'], 'widget restart');
      if (restart) {
        for (let i = 0; i < 15; i++) {
          const s = await popupState(page);
          if (s.present && s.img && s.img.srcLen > 500) break;
          await sleep(2000);
        }
        const okr = await solveWidget(page);
        log('captcha', `re-solve after click ${clickN}: ${okr}`);
      }
    }
    log('after-signup', `url=${page.url()} title="${await page.title()}"`);
    await page.screenshot({ path: `${OUTDIR}/after_signup.png` }).catch(() => {});
    fs.writeFileSync(`${OUTDIR}/api_log.json`, JSON.stringify(apiLog, null, 2));
    const signupOk = apiLog.some((a) => /auths\/signup$/.test(a.url) && a.status === 200);
    log('signup', `POST /auths/signup 200 = ${signupOk}`);
    if (!signupOk) { log('fail', 'signup POST did not return 200'); }

    /* ---- phase 2: verify + SET PASSWORD (the #9 lesson) ---- */
    const { link, subject } = await pollMailLink(email, 180000, /z\.ai|zai|verify|password|reset/i);
    log('mail', `link: ${link ? link.slice(0, 90) : 'NONE (' + subject + ')'}`);
    if (!link) { await browser.close(); process.exit(6); }
    await page.goto(link, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await sleep(3500);
    let vfr = await formReport(page);
    log('verify-form', JSON.stringify(vfr).slice(0, 500));
    await page.screenshot({ path: `${OUTDIR}/verify_page.png` }).catch(() => {});
    // complete ANY password/set-password form on the verify page
    let pwSet = false;
    for (const [sel, val] of [
      ['input#password', password], ['input[name="password"]', password], ['input[type="password"]', password],
    ]) {
      const loc = page.locator(sel).first();
      try { if (await loc.count() && await loc.isVisible()) { await loc.fill(val, { timeout: 3000 }); pwSet = true; log('verify', `password field via ${sel}`); break; } } catch {}
    }
    if (pwSet) {
      for (const sel of ['button:has-text("Confirm")', 'button:has-text("Submit")', 'button:has-text("Set")', 'button:has-text("Verify")', 'button:has-text("Continue")', 'button[type="submit"]']) {
        const loc = page.locator(sel).first();
        try { if (await loc.count() && await loc.isVisible()) { await loc.click({ timeout: 3000 }); log('verify', `clicked ${sel}`); break; } } catch {}
      }
      await sleep(6000);
      log('verify', `after set-pw: url=${page.url()}`);
      await page.screenshot({ path: `${OUTDIR}/after_setpw.png` }).catch(() => {});
    } else { log('verify', 'no password field on verify page (auto-verify path)'); }

    /* ---- phase 3: signin (the last mile) ---- */
    let user = await sessionUser(page);
    log('session', `after verify: ${JSON.stringify(user)}`);
    if (isGuest(user)) {
      await page.goto('https://chat.z.ai/auth', { timeout: 60000, waitUntil: 'domcontentloaded' });
      await sleep(2500);
      const ok = await emailFormSubmit(page, { email, password, submitLabel: 'Sign in' });
      log('signin', `flow ran=${ok}`);
      await sleep(4000);
      user = await sessionUser(page);
      log('session', `after signin: ${JSON.stringify(user)}`);
      await page.screenshot({ path: `${OUTDIR}/after_signin.png` }).catch(() => {});
    }

    let finalPassword = password;
    /* ---- phase 3b: forgot-password recovery (if signin failed) ---- */
    if (isGuest(user)) {
      log('recovery', 'signin failed — trying forgot-password flow');
      await page.goto('https://chat.z.ai/auth', { timeout: 60000, waitUntil: 'domcontentloaded' });
      await sleep(2500);
      await clickFirst(page, ['text=Continue with Email', 'button:has-text("Continue with Email")'], 'email entry');
      await sleep(2000);
      const forgot = await clickFirst(page, ['text=Forgot password', 'a:has-text("Forgot password")', 'text=Forgot'], 'forgot link');
      if (forgot) {
        await sleep(2000);
        for (const [sel, val] of [['input[type="email"]', email], ['input[name="email"]', email]]) {
          const loc = page.locator(sel).first();
          try { if (await loc.count() && await loc.isVisible()) { await loc.fill(val, { timeout: 3000 }); break; } } catch {}
        }
        // captcha may gate the forgot request too
        if (await widgetNeedsStart(page)) {
          await clickFirst(page, ['text=Click to start verification', '#aliyunCaptcha-captcha-text'], 'widget start (forgot)');
          for (let i = 0; i < 15; i++) {
            const s = await popupState(page);
            if (s.present && s.img && s.img.srcLen > 500) break;
            await sleep(2000);
          }
          await solveWidget(page);
        }
        await clickFirst(page, ['button:has-text("Send")', 'button:has-text("Submit")', 'button[type="submit"]'], 'send reset');
        const reset = await pollMailLink(email, 180000, /reset|password/i);
        log('recovery', `reset link: ${reset.link ? reset.link.slice(0, 90) : 'NONE'}`);
        if (reset.link) {
          finalPassword = `Zk${Math.random().toString(36).slice(2, 8)}!R${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
          await page.goto(reset.link, { timeout: 60000, waitUntil: 'domcontentloaded' });
          await sleep(3000);
          for (const [sel, val] of [['input#password', finalPassword], ['input[name="password"]', finalPassword], ['input[type="password"]', finalPassword]]) {
            const loc = page.locator(sel).first();
            try { if (await loc.count() && await loc.isVisible()) { await loc.fill(val, { timeout: 3000 }); log('recovery', `pw via ${sel}`); break; } } catch {}
          }
          await clickFirst(page, ['button:has-text("Reset")', 'button:has-text("Confirm")', 'button:has-text("Submit")', 'button[type="submit"]'], 'reset submit');
          await sleep(6000);
          await page.goto('https://chat.z.ai/auth', { timeout: 60000, waitUntil: 'domcontentloaded' });
          await sleep(2000);
          await emailFormSubmit(page, { email, password: finalPassword, submitLabel: 'Sign in' });
          await sleep(4000);
          user = await sessionUser(page);
          log('session', `after recovery signin: ${JSON.stringify(user)}`);
        }
      } else { log('recovery', 'no forgot-password link found'); }
    }

    const loggedIn = !isGuest(user);
    log('session', `LOGGED IN = ${loggedIn} (${user.email || 'guest'})`);

    /* ---- phase 4: API key mint (the tail) ---- */
    let apiKey = null;
    if (loggedIn) {
      const r = await page.evaluate(async () => {
        const res = await fetch('/api/v1/auths/api_key', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        let j = null; try { j = await res.json(); } catch {}
        return { status: res.status, body: j };
      }).catch((e) => ({ status: 0, err: e.message }));
      log('apikey', `POST /auths/api_key → ${r.status} ${JSON.stringify(r.body || {}).slice(0, 200)}`);
      if (r.status === 200 && r.body) {
        apiKey = r.body.api_key || r.body.key || (r.body.data && r.body.data.api_key) || null;
        if (apiKey) log('apikey', `MINTED: ${String(apiKey).slice(0, 8)}...`);
      }
      // try the alternate surface if the first failed
      if (!apiKey) {
        const r2 = await page.evaluate(async () => {
          const res = await fetch('/api/v1/users/api-keys', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          let j = null; try { j = await res.json(); } catch {}
          return { status: res.status, body: j };
        }).catch((e) => ({ status: 0, err: e.message }));
        log('apikey', `POST /users/api-keys → ${r2.status} ${JSON.stringify(r2.body || {}).slice(0, 200)}`);
        if (r2.status === 200 && r2.body) apiKey = r2.body.api_key || (r2.body.data && r2.body.data.api_key) || null;
      }
    }

    /* ---- phase 5: emit ---- */
    const cookies = await cookiesOf(ctx);
    const out = {
      service: 'zai', email, password: finalPassword, name,
      user_id: user && user.id, api_key: apiKey,
      session_token: cookies.token || null, cookies,
      mail_domain: MAIL_DOMAIN, runner_ip: (await (await fetch('https://api.ipify.org').catch(() => ({ text: async () => 'unknown' }))).text()),
      logged_in: loggedIn, api_key_minted: !!apiKey,
      run_tag: RUN_TAG, created_at: new Date().toISOString(),
      route: 'gha-runner',
    };
    const outFile = path.join(OUTDIR, `zai-${RUN_TAG}.json`);
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    fs.writeFileSync(`${OUTDIR}/api_log_final.json`, JSON.stringify(apiLog, null, 2));
    log('done', `CREDS → ${outFile} | logged_in=${loggedIn} api_key=${!!apiKey}`);
    await browser.close();
    process.exit(loggedIn ? 0 : 8);
  } catch (e) {
    log('exception', (e.message || e).split('\n')[0]);
    await page.screenshot({ path: `${OUTDIR}/exception.png` }).catch(() => {});
    fs.writeFileSync(`${OUTDIR}/api_log_final.json`, JSON.stringify(apiLog, null, 2));
    await browser.close().catch(() => {});
    process.exit(7);
  }
})();
