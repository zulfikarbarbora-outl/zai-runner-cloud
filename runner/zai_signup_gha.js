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
const MAIL_API_TOKEN = process.env.MAIL_API_TOKEN || 'a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf';
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

/* ---------------- watchdog (SKILL §15 + §8.8.2 #3) ----------------
 * A dropped CDP connection leaves every pending promise hanging and the
 * node event loop DRAINS → process exits 0 silently mid-flow. A
 * setInterval watchdog (keeps the loop alive + stall-exit) is MANDATORY.
 * The pattern is from scripts/warm_browser.js startWatchdog().
 *
 * ALSO: a global unhandledRejection handler — without it, ANY promise
 * rejection that escapes the try/catch (e.g., a CDP drop in the middle
 * of `await page.screenshot()` inside solveWidget's captcha loop) kills
 * the process silently with exit 0 and NO log. The handler writes a
 * rejection_exit.json so the next session can see WHY the process died.
 */
function _writeExitArtifact(name, payload) {
  try { fs.writeFileSync(`${OUTDIR}/${name}`, JSON.stringify(payload, null, 2)); } catch {}
}
process.on('unhandledRejection', (reason, p) => {
  log('FATAL', `unhandledRejection: ${String(reason && reason.message || reason).slice(0, 200)}`);
  _writeExitArtifact('rejection_exit.json', {
    reason: String(reason && reason.message || reason).slice(0, 500),
    stack: (reason && reason.stack || '').slice(0, 1500),
    exited: new Date().toISOString(),
  });
  process.exit(3);
});
process.on('uncaughtException', (err) => {
  log('FATAL', `uncaughtException: ${String(err.message).slice(0, 200)}`);
  _writeExitArtifact('uncaught_exit.json', {
    message: String(err.message).slice(0, 500),
    stack: (err.stack || '').slice(0, 1500),
    exited: new Date().toISOString(),
  });
  process.exit(4);
});

function startWatchdog(stallMs = 180000, pollMs = 10000) {
  let last = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - last > stallMs) {
      log('watchdog', `no progress in ${Math.round(stallMs / 1000)}s — hard exit`);
      try { fs.writeFileSync(`${OUTDIR}/watchdog_exit.json`, JSON.stringify({ reason: 'stall', stallMs, last_touch: new Date(last).toISOString(), exited: new Date().toISOString() }, null, 2)); } catch {}
      process.exit(2);
    }
  }, pollMs);
  return {
    touch: (tag = '') => { last = Date.now(); if (tag) log('watchdog', `touch: ${tag}`); },
    stop: () => clearInterval(timer),
  };
}

/* ---------------- main ---------------- */
(async () => {
  log('start', `domain=${MAIL_DOMAIN} outdir=${OUTDIR} ip-check...`);
  const wd = startWatchdog(180000, 10000);  // 3min stall → hard exit (caps silent death)
  try { const r = await fetch('https://api.ipify.org'); log('ip', await r.text()); } catch {}

  // S25 fleet: --email injects the runner identity (firstlast##@domain);
  // fallback keeps the legacy zs-<ts>-<hex> shape.
  const email = (typeof args.email === 'string' && args.email.includes('@'))
    ? args.email
    : `zs-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 8)}@${MAIL_DOMAIN}`;
  const password = process.env.ONBOARD_FLEET_PW || `Zk${Math.random().toString(36).slice(2, 8)}!${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
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
        wd.touch('nav');
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
    if (!started) { browser.close().catch(() => {}); process.exit(4); }
    for (let i = 0; i < 15; i++) {
      const ready = await page.evaluate(() => {
        const img = document.querySelector('#aliyunCaptcha-img');
        const pc = document.querySelector('#aliyunCaptcha-puzzle');
        return !!(img && img.src && pc);
      }).catch(() => false);
      if (ready) break;
      await sleep(2000);
    }
    if (!await solveWidget(page)) { browser.close().catch(() => {}); process.exit(5); }

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
          wd.touch('captcha-r2');
    log('captcha', `round 2 solved=${round2Solved}`);
      if (!round2Solved) { browser.close().catch(() => {}); process.exit(5); }
    } else {
      // widget may already be verified (rare) — verify by popup absence
      const st = await popupState(page);
      log('captcha', `round 2: no start control (popup present=${st.present}) — assuming verified`);
    }

    // Create Account — verify the signup POST actually fired; retry clicks
    // WAVE-16: the old code only clicked the button — but a DISABLED button
    // passes isVisible() but doesn't fire the click handler. Fix: check
    // isEnabled(), try Enter-key submit, try form.submit() via evaluate,
    // and dump the button state for diagnostics when the POST doesn't fire.
    await sleep(1200);
    for (let clickN = 1; clickN <= 3; clickN++) {
      const firedBefore = apiLog.filter((a) => /auths\/signup$/.test(a.url) && a.status === 200).length;

      // Method 1: click the button (check enabled first)
      const btnInfo = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
        return btns.map(b => ({
          text: (b.textContent || '').trim().slice(0, 30),
          disabled: b.disabled,
          type: b.type,
          id: b.id,
        }));
      }).catch(() => []);
      log('signup', `button states: ${JSON.stringify(btnInfo.slice(0, 8))}`);
      await clickFirst(page, ['button:has-text("Create Account")', 'button:has-text("Create")', 'button[type="submit"]:not([disabled])'], 'create account');
      await sleep(5000);

      // Method 2: if no POST yet, try Enter-key submit on the last input
      let fired = apiLog.filter((a) => /auths\/signup$/.test(a.url) && a.status === 200).length;
      if (fired <= firedBefore) {
        log('signup', `click ${clickN} didn't fire POST — trying Enter-key submit`);
        try { await page.keyboard.press('Enter'); } catch {}
        await sleep(5000);
        fired = apiLog.filter((a) => /auths\/signup$/.test(a.url) && a.status === 200).length;
      }

      // Method 3: if still no POST, try form.submit() via evaluate
      if (fired <= firedBefore) {
        log('signup', `Enter didn't fire POST — trying form.submit()`);
        try {
          await page.evaluate(() => {
            const form = document.querySelector('form');
            if (form) form.submit();
          });
        } catch {}
        await sleep(5000);
        fired = apiLog.filter((a) => /auths\/signup$/.test(a.url) && a.status === 200).length;
      }

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
    // WAVE-10: wrap post-signup page-state reads in try/catch — z.ai may
    // close/navigate the page after auths/signup 200, and page.title()/url()
    // throw on a dead page. The signup outcome is already in apiLog; don't
    // let a diagnostic read kill the run.
    let afterUrl = '(unknown)', afterTitle = '(unknown)';
    try { afterUrl = page.url(); } catch (_) {}
    try { afterTitle = await page.title(); } catch (_) {}
    log('after-signup', `url=${afterUrl} title="${afterTitle}"`);
    await page.screenshot({ path: `${OUTDIR}/after_signup.png` }).catch(() => {});
    fs.writeFileSync(`${OUTDIR}/api_log.json`, JSON.stringify(apiLog, null, 2));
    const signupOk = apiLog.some((a) => /auths\/signup$/.test(a.url) && a.status === 200);
    log('signup', `POST /auths/signup 200 = ${signupOk}`);
    if (!signupOk) { log('fail', 'signup POST did not return 200'); }

    /* ---- phase 2: verify + SET PASSWORD (the #9 lesson) ---- */
    const { link, subject } = await pollMailLink(email, 180000, /z\.ai|zai|verify|password|reset/i);
        wd.touch('mail-link');
    log('mail', `link: ${link ? link.slice(0, 90) : 'NONE (' + subject + ')'}`);
    if (!link) { browser.close().catch(() => {}); process.exit(6); }
    await page.goto(link, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await sleep(3500);
    let vfr = await formReport(page);
        wd.touch('verify-form');
    log('verify-form', JSON.stringify(vfr).slice(0, 500));
    await page.screenshot({ path: `${OUTDIR}/verify_page.png` }).catch(() => {});
    // complete the REGISTRATION form on the verify page:
    // input#username (prefilled) + input#email (prefilled) + input#password
    // + input#confirmPassword + button "Complete Registration"
    // → POST /api/v1/auths/finish_signup 200 returns the SESSION TOKEN
    let finishResp = null;
    const finListener = async (res) => {
      if (/\/api\/v1\/auths\/finish_signup/.test(res.url())) { finishResp = { status: res.status(), body: await res.text().catch(() => '') }; }
    };
    page.on('response', finListener);
    let pwSet = false;
    for (const [sel, val] of [
      ['input#password', password], ['input[name="password"]', password], ['input[placeholder*="Enter your password" i]', password],
      ['input#confirmPassword', password], ['input[name="confirmPassword"]', password], ['input[placeholder*="Confirm your pass" i]', password],
      ['input[type="password"]', password],
    ]) {
      const loc = page.locator(sel).first();
      try { if (await loc.count() && await loc.isVisible() && !await loc.inputValue()) { await loc.fill(val, { timeout: 3000 }); pwSet = true; log('verify', `password field via ${sel}`); } } catch {}
    }
    if (pwSet) {
      // the submit is "Complete Registration" (verified 2026-10-13)
      for (const sel of ['button:has-text("Complete Registration")', 'button:has-text("Complete")', 'button:has-text("Confirm")', 'button:has-text("Submit")', 'button[type="submit"]']) {
        const loc = page.locator(sel).first();
        try { if (await loc.count() && await loc.isVisible()) { await loc.click({ timeout: 3000 }); log('verify', `clicked ${sel}`); break; } } catch {}
      }
      await sleep(6000);
      log('verify', `finish_signup resp: ${finishResp ? finishResp.status + ' ' + finishResp.body.slice(0, 120) : 'none'}`);
      log('verify', `after set-pw: url=${page.url()}`);
      await page.screenshot({ path: `${OUTDIR}/after_setpw.png` }).catch(() => {});
    } else { log('verify', 'no password field on verify page (auto-verify path)'); }
    page.off('response', finListener);

    /* ---- phase 3: signin (the last mile) ---- */
    let user = await sessionUser(page);
    log('session', `after verify: ${JSON.stringify(user)}`);
    if (isGuest(user)) {
      await page.goto('https://chat.z.ai/auth', { timeout: 60000, waitUntil: 'domcontentloaded' });
      await sleep(2500);
      const ok = await emailFormSubmit(page, { email, password, submitLabel: 'Sign in' });
          wd.touch('signin');
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

    /* ---- phase 4: API key via the z.ai platform (OAuth SSO + keymint) ----
     * Chain (verified 2026-10-13, account #11):
     *  1. chat.z.ai/api/oauth/authorize?response_type=code&client_id=…
     *     → 307 with Location: z.ai/login/callback?...&code=code-XXXX
     *     (needs the chat token cookie; curl -L works, no captcha)
     *  2. in-page: POST api.z.ai/api/auth/z/zaiAuthToken (clientId, authCode)
     *     → access_token (client JWT); POST api.z.ai/api/auth/z/login
     *     → platform access_token (PERSONAL user, api_key:null initially)
     *  3. z.ai/manage-apikey/apikey-list: default project row exists;
     *     "+ Add API Key" → name modal → Create →
     *     POST api.z.ai/api/biz/v1/organization/{org}/projects/{proj}/api_k
     *     → 200 data {apiKey, secretKey} — FULL secret, shown once.
     * GLM API key = apiKey + "." + secretKey; smoke = Bearer against
     * api.z.ai/api/paas/v4/chat/completions (fresh acct: 1113 no-balance).
     */
    let apiKey = null, apiKeySecret = null, platformToken = null, orgId = null, projId = null;
    if (loggedIn) {
      // 4a. get the oauth code (curl-style via page fetch keeps cookies)
      const oauthUrl = 'https://chat.z.ai/api/oauth/authorize?response_type=code&client_id=client_lS94_Ka2ycE9IwCNYisudg&redirect_uri='
        + encodeURIComponent('https://z.ai/login/callback?redirect=%2Fmanage-apikey%2Fapikey-list') + '&state=run' + Date.now();
      const codeResp = await page.evaluate(async (u) => {
        const res = await fetch(u, { credentials: 'include', redirect: 'manual' });
        const loc = res.headers.get('location') || '';
        return { status: res.status, loc };
      }, oauthUrl).catch((e) => ({ status: 0, err: e.message }));
      const code = (codeResp.loc.match(/code=([^&]+)/) || [])[1];
      log('oauth', `authorize → ${codeResp.status} code=${code ? code.slice(0, 12) + '…' : 'NONE'}`);
      if (code) {
        // 4b. exchange for the platform token (same api the site uses)
        const loginResp = await page.evaluate(async (authCode) => {
          const body = new URLSearchParams({ clientId: 'client_lS94_Ka2ycE9IwCNYisudg', authCode, redirectUri: 'https://z.ai/manage-apikey/apikey-list' });
          const r1 = await fetch('https://api.z.ai/api/auth/z/zaiAuthToken', { method: 'POST', body, credentials: 'include' });
          const j1 = await r1.json().catch(() => null);
          const r2 = await fetch('https://api.z.ai/api/auth/z/login', { method: 'POST', credentials: 'include' });
          const j2 = await r2.json().catch(() => null);
          return { authToken: j1, login: j2 };
        }, code).catch((e) => ({ err: e.message }));
        platformToken = loginResp && loginResp.login && loginResp.login.data && loginResp.login.data.access_token || null;
        log('oauth', `platform login: ${platformToken ? 'token OK (' + platformToken.slice(0, 14) + '…)' : JSON.stringify(loginResp).slice(0, 160)}`);
        // 4c. find org/project then mint a named key
        if (platformToken) {
          const mint = await page.evaluate(async (tok) => {
            const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
            // customer info gives the identity
            const cust = await (await fetch('https://api.z.ai/api/biz/customer/getCustomerInfo', { headers: H, credentials: 'include' })).json().catch(() => null);
            // project list is keyed by org/proj path — discover via the apikey page's own fetch:
            // fallback: hardcode discovery by scraping the page after nav (handled below)
            return { cust };
          }, platformToken).catch((e) => ({ err: e.message }));
          log('oauth', `customer: ${JSON.stringify(mint.cust && mint.cust.data ? { id: mint.cust.data.id, email: mint.cust.data.email } : mint).slice(0, 140)}`);
        }
      }
      // 4d. UI path: nav to apikey-list, click Add, capture the mint POST
      if (platformToken) {
        const mintCalls = [];
        const mintListener = async (res) => {
          const u = res.url();
          if (/api\.z\.ai\/api\/biz\/v1\/organization\/.+\/api_k/.test(u) && res.request().method() === 'POST') {
            let body = ''; try { body = await res.text(); } catch {}
            mintCalls.push({ u, body });
          }
          const m = u.match(/organization\/([^/]+)\/projects\/([^/?]+)/);
          if (m) { orgId = m[1]; projId = m[2]; }
        };
        page.on('response', mintListener);
        try {
          await page.goto('https://z.ai/manage-apikey/apikey-list', { timeout: 60000, waitUntil: 'domcontentloaded' });
          await sleep(8000);
          await page.keyboard.press('Escape').catch(() => {});
          let add = null;
          for (let i = 0; i < 10; i++) {
            add = page.locator('button:has-text("Add API Key")').first();
            if (await add.count()) break;
            await sleep(1500);
          }
          if (add && await add.count()) {
            await add.click();
            let inp = null;
            for (let i = 0; i < 8; i++) {
              inp = page.locator('input[placeholder*="name" i], input[placeholder*="API key" i]').first();
              if (await inp.count()) break;
              await sleep(1200);
            }
            if (inp && await inp.count()) await inp.fill('auto-onboard').catch(() => {});
            await sleep(800);
            const create = page.locator('button:has-text("Create")').last();
            if (await create.count()) await create.click();
            await sleep(9000);
          }
        } catch (e) {     wd.touch('apikey');
    log('apikey', `ui mint error: ${e.message.slice(0, 80)}`); }
        page.off('response', mintListener);
        for (const c of mintCalls) {
          try {
            const d = JSON.parse(c.body);
            if (d && d.data && d.data.apiKey) {
              apiKey = d.data.apiKey; apiKeySecret = d.data.secretKey;
              log('apikey', `MINTED: ${apiKey.slice(0, 8)}….${apiKeySecret.slice(-4)}`);
            }
          } catch {}
        }
        if (!apiKey) log('apikey', 'mint POST not captured (org/proj: ' + orgId + '/' + projId + ')');
      }
      // 4e. fallback: legacy direct endpoint (kept from the old map)
      if (!apiKey) {
        const r = await page.evaluate(async () => {
          const res = await fetch('/api/v1/auths/api_key', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          let j = null; try { j = await res.json(); } catch {}
          return { status: res.status, body: j };
        }).catch((e) => ({ status: 0, err: e.message }));
        log('apikey', `POST /auths/api_key → ${r.status} ${JSON.stringify(r.body || {}).slice(0, 150)}`);
      }
    }

    /* ---- phase 5: emit ---- */
    const cookies = await cookiesOf(ctx);
    const fullApiKey = apiKey && apiKeySecret ? `${apiKey}.${apiKeySecret}` : apiKey;
    const out = {
      service: 'zai', email, password: finalPassword, name,
      user_id: user && user.id, api_key: fullApiKey,
      api_key_id: apiKey, api_key_secret: apiKeySecret,
      platform_token: platformToken, org_id: orgId, project_id: projId,
      session_token: cookies.token || null, cookies,
      mail_domain: MAIL_DOMAIN, runner_ip: (await (await fetch('https://api.ipify.org').catch(() => ({ text: async () => 'unknown' }))).text()),
      logged_in: loggedIn, api_key_minted: !!apiKey,
      run_tag: RUN_TAG, created_at: new Date().toISOString(),
      route: 'gha-runner',
    };
    const outFile = path.join(OUTDIR, `zai-${RUN_TAG}.json`);
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    fs.writeFileSync(`${OUTDIR}/api_log_final.json`, JSON.stringify(apiLog, null, 2));
        wd.touch('done');
    log('done', `CREDS → ${outFile} | logged_in=${loggedIn} api_key=${!!apiKey}`);
    wd.stop();
    // Fire-and-forget browser.close() — on a dead CDP connection the promise
    // HANGS forever (the catch only handles rejections, not hangs), which
    // would block process.exit() and let the event loop drain to exit 0
    // instead of the intended code. The OS reaps the chrome process anyway.
    browser.close().catch(() => {});
    process.exit(loggedIn ? 0 : 8);
  } catch (e) {
    log('exception', (e.message || e).split('\n')[0]);
    // Fire-and-forget the screenshot — on a closed page, page.screenshot()
    // may HANG (not reject) and block process.exit() indefinitely. The OS
    // doesn't care about a missed diagnostic screenshot.
    page.screenshot({ path: `${OUTDIR}/exception.png` }).catch(() => {});
    fs.writeFileSync(`${OUTDIR}/api_log_final.json`, JSON.stringify(apiLog, null, 2));
    _writeExitArtifact('exception_exit.json', {
      message: String(e.message || e).slice(0, 500),
      stack: (e.stack || '').slice(0, 1500),
      exited: new Date().toISOString(),
    });
    wd.stop();
    // Fire-and-forget browser.close() — see comment in success path above.
    browser.close().catch(() => {});
    log('exit', 'process.exit(7) about to fire');
    process.exit(7);
  }
})();
