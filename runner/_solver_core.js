/* Solver core — extracted from onboard-automation-common
 * scripts/zai_local_solver.js lines 41-456 (proven 2026-10-10: signup
 * e2e solved on the local tier; gearing p(h)=a*h+b*h^2 stable).
 * Caller must define: OUTDIR (string), chromium (playwright), fs, and
 * call these helpers with a live page. */

function log(tag, ...m) { console.log(`[${new Date().toISOString().slice(11, 19)}][${tag}]`, ...m); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- launch (local tier) ---------------- */
async function launchLocal() {
  const attempts = [
    () => chromium.launch({ channel: 'chromium', headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox',
             '--disable-dev-shm-usage', '--window-size=1440,900'] }),
    () => chromium.launch({ headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox',
             '--disable-dev-shm-usage', '--window-size=1440,900'] }),
  ];
  for (const a of attempts) { try { return await a(); } catch (e) { log('launch', e.message.split('\n')[0]); } }
  throw new Error('all launch modes failed');
}

/* ---------------- popup inspection ---------------- */
async function popupState(page) {
  return page.evaluate(() => {
    const pop = document.querySelector('#aliyunCaptcha-window-float, [id*="aliyunCaptcha-window"]');
    if (!pop) return { present: false };
    const visible = pop.offsetParent !== null || getComputedStyle(pop).display !== 'none';
    const img = document.querySelector('#aliyunCaptcha-img');
    // slider candidates
    const sliders = [...document.querySelectorAll('[id*="slider" i], [class*="slider" i], [id*="nc_1" i], [class*="btn_slide" i]')]
      .map((el) => ({ id: el.id, cls: String(el.className).slice(0, 40), tag: el.tagName }))
      .filter((s) => s.id || s.cls).slice(0, 12);
    return {
      present: true, visible,
      title: (document.querySelector('#aliyunCaptcha-title') || {}).textContent || '',
      text: (pop.innerText || '').slice(0, 200),
      img: img ? { id: img.id, natural: [img.naturalWidth, img.naturalHeight], display: [img.width, img.height],
                   box: (r => r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null)(img.getBoundingClientRect()),
                   srcLen: (img.src || '').length } : null,
      sliders,
    };
  }).catch((e) => ({ present: false, err: e.message }));
}

/* save puzzle image + full popup DOM + geometry */
async function dumpPopup(page, tag) {
  const st = await popupState(page);
  fs.writeFileSync(`${OUTDIR}/popup_${tag}.json`, JSON.stringify(st, null, 2));
  // full popup DOM (no slicing this time)
  const html = await page.evaluate(() => {
    const pop = document.querySelector('#aliyunCaptcha-window-float, [id*="aliyunCaptcha-window"]');
    return pop ? pop.outerHTML : '';
  }).catch(() => '');
  if (html) fs.writeFileSync(`${OUTDIR}/popup_${tag}.html`, html);
  // puzzle bg + piece images → files
  const imgs = await page.evaluate(() => {
    const out = {};
    const bg = document.querySelector('#aliyunCaptcha-img');
    if (bg && bg.src && bg.src.startsWith('data:')) out.bg = { b64: bg.src.split(',')[1], natural: [bg.naturalWidth, bg.naturalHeight] };
    const pc = document.querySelector('#aliyunCaptcha-puzzle');
    if (pc) {
      const r = pc.getBoundingClientRect();
      out.piece = {
        isData: (pc.src || '').startsWith('data:'),
        b64: (pc.src || '').startsWith('data:') ? pc.src.split(',')[1] : null,
        natural: [pc.naturalWidth, pc.naturalHeight],
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        styleLeft: pc.style.left, styleTop: pc.style.top, src: (pc.src || '').slice(0, 140),
      };
    }
    return out;
  }).catch(() => ({}));
  if (imgs.bg) { fs.writeFileSync(`${OUTDIR}/puzzle_bg_${tag}.png`, Buffer.from(imgs.bg.b64, 'base64')); }
  if (imgs.piece && imgs.piece.b64) fs.writeFileSync(`${OUTDIR}/puzzle_piece_${tag}.png`, Buffer.from(imgs.piece.b64, 'base64'));
  await page.screenshot({ path: `${OUTDIR}/shot_${tag}.png` }).catch(() => {});
  log('dump', `popup_${tag}: bg=${imgs.bg ? imgs.bg.natural.join('x') : 'none'} piece=${imgs.piece ? `${imgs.piece.natural.join('x')} left=${imgs.piece.styleLeft} box=${JSON.stringify(imgs.piece.box)} src=${imgs.piece.isData ? 'data:' : imgs.piece.src.slice(0, 60)}` : 'none'}`);
  return st;
}

/* read live piece/handle positions (coupling check) */
async function livePositions(page) {
  return page.evaluate(() => {
    const g = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { styleLeft: el.style.left || '', x: Math.round(r.x), w: Math.round(r.width) }; };
    return {
      piece: g(document.querySelector('#aliyunCaptcha-puzzle')),
      handle: g(document.querySelector('#aliyunCaptcha-sliding-slider')),
      progress: g(document.querySelector('#aliyunCaptcha-sliding-left')),
    };
  }).catch((e) => ({ err: e.message }));
}

/* ---------------- in-page gap detection ----------------
 * The Aliyun puzzle: background photo with a puzzle-piece-shaped hole
 * (semi-transparent dark). Scan columns: the hole is a contiguous band
 * with (a) low luminance and (b) low per-column variance (flat gray).
 * Report the top-3 candidate bands so calibration can pick the rule.
 */
async function detectGap(page) {
  return page.evaluate(() => {
    const img = document.querySelector('#aliyunCaptcha-img');
    if (!img) return { err: 'no img' };
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const lum = (x, y) => { const i = (y * w + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
    // column stats over middle band (30%-70%) — the hole sits mid-image
    const y0 = Math.floor(h * 0.3), y1 = Math.floor(h * 0.7);
    const cols = [];
    for (let x = 0; x < w; x++) {
      let s = 0, s2 = 0; const n = y1 - y0;
      for (let y = y0; y < y1; y++) { const l = lum(x, y); s += l; s2 += l * l; }
      const m = s / n; const v = Math.max(0, s2 / n - m * m);
      cols.push({ x, mean: m, sd: Math.sqrt(v) });
    }
    // candidate 1: darkest contiguous run (width 20..90) of column means
    const runs = [];
    let i = 0;
    while (i < w) {
      if (cols[i].mean < 90) { // dark column
        let j = i; while (j < w && cols[j].mean < 110) j++;
        if (j - i >= 18 && j - i <= 100) runs.push({ x0: i, x1: j, w: j - i, mean: (cols.slice(i, j).reduce((a, b) => a + b.mean, 0)) / (j - i) });
        i = j;
      } else i++;
    }
    runs.sort((a, b) => a.mean - b.mean);
    // candidate 2: lowest-variance (flattest) contiguous run — the hole is flat gray
    const flat = [];
    i = 0;
    while (i < w) {
      if (cols[i].sd < 18) {
        let j = i; while (j < w && cols[j].sd < 26) j++;
        if (j - i >= 18 && j - i <= 100) flat.push({ x0: i, x1: j, w: j - i, sd: (cols.slice(i, j).reduce((a, b) => a + b.sd, 0)) / (j - i) });
        i = j;
      } else i++;
    }
    flat.sort((a, b) => a.sd - b.sd);
    // edge-pair candidate: two strong vertical gradient spikes 20-90px apart
    const grad = [];
    for (let x = 2; x < w - 2; x++) {
      let g = 0; for (let y = y0; y < y1; y++) g += Math.abs(lum(x + 2, y) - lum(x - 2, y));
      grad.push({ x, g: g / (y1 - y0) });
    }
    const spikes = grad.filter((p) => p.g > 34).map((p) => p.x);
    const pairs = [];
    for (let a = 0; a < spikes.length; a++)
      for (let b = a + 1; b < spikes.length && spikes[b] - spikes[a] <= 100; b++)
        if (spikes[b] - spikes[a] >= 18) pairs.push({ x0: spikes[a], x1: spikes[b], w: spikes[b] - spikes[a] });
    pairs.sort((a, b) => a.w - b.w);
    const box = img.getBoundingClientRect();
    return {
      imgW: w, imgH: h, displayW: Math.round(box.width), displayH: Math.round(box.height),
      scaleX: w / box.width, darkRuns: runs.slice(0, 3), flatRuns: flat.slice(0, 3), edgePairs: pairs.slice(0, 6),
    };
  }).catch((e) => ({ err: e.message }));
}

/* ---------------- humanized drag ---------------- */
async function humanDrag(page, handleBox, distance) {
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY, { steps: 3 });
  await page.mouse.down();
  const steps = 38 + Math.floor(Math.random() * 14);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const target = eased * distance;
    const jitterY = (Math.random() - 0.5) * 2.4;
    await page.mouse.move(startX + target + (Math.random() - 0.5) * 1.6, startY + jitterY, { steps: 1 });
    await page.waitForTimeout(11 + Math.random() * 24);
  }
  await page.mouse.move(startX + distance, startY + (Math.random() - 0.5), { steps: 2 });
  await page.waitForTimeout(160 + Math.random() * 240);
  await page.mouse.up();
  log('drag', `humanized ${Math.round(distance)}px over ~1.3s`);
}

/* ---------------- THE SOLVER (reusable) ----------------
 * solveWidget(page): assumes the popup is open with a puzzle.
 * 1. extract bg+piece srcs (data URI, or remote → Node fetch roundtrip)
 * 2. in-page template match on a scratch canvas (no taint)
 * 3. self-calibrating humanized drag:
 *    piece styleLeft p(h) = a·h + b·h² (h = handle styleLeft).
 *    Probe 2 mid-drag positions, fit the quadratic (f(0)=0 is the
 *    3rd point), solve for the handle position that parks the piece
 *    at the best-match offset. Proven 2026-10-10: SOLVED try-1;
 *    coefficients stable across sessions (0.0769 / 0.00355).
 * 4. on fail: refresh → re-match → retry (max 5).
 * Returns true if the popup closed / success text.
 */
async function solveWidget(page) {
  const getHandle = () => page.evaluate(() => {
    const el = document.querySelector('#aliyunCaptcha-sliding-slider');
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const handle = await getHandle();
  if (!handle) { log('solve', 'no slider handle'); await dumpPopup(page, 'nohandle'); return false; }
  log('slider', `handle at ${JSON.stringify(handle)}`);

  const toDataUri = async (src) => {
    if (!src) return null;
    if (src.startsWith('data:')) return src;
    try {
      const r = await fetch(src);
      const buf = Buffer.from(await r.arrayBuffer());
      return `data:${r.headers.get('content-type') || 'image/png'};base64,${buf.toString('base64')}`;
    } catch (e) { log('fetch', `remote image failed: ${e.message}`); return null; }
  };
  const matchInPage = async () => {
    const s = await page.evaluate(() => {
      const out = {};
      const bg = document.querySelector('#aliyunCaptcha-img');
      const pc = document.querySelector('#aliyunCaptcha-puzzle');
      if (bg) out.bg = bg.src || '';
      if (pc) out.piece = pc.src || '';
      return out;
    });
    const bgUri = await toDataUri(s.bg), pieceUri = await toDataUri(s.piece);
    if (!bgUri || !pieceUri) return null;
    return page.evaluate(async ({ bgUri, pieceUri }) => {
      const load = (u) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = u; });
      const [bgIm, pcIm] = await Promise.all([load(bgUri), load(pieceUri)]);
      const W = bgIm.naturalWidth, H = bgIm.naturalHeight, PW = pcIm.naturalWidth, PH = pcIm.naturalHeight;
      const mk = (im, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(im, 0, 0); return c.getContext('2d').getImageData(0, 0, w, h).data; };
      const bgD = mk(bgIm, W, H), pcD = mk(pcIm, PW, PH);
      const lumAt = (d, w, x, y) => { const i = (y * w + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
      // content columns: ≥3 opaque pixels (alpha>100). Handles BOTH shapes:
      // full-height strips (alpha~50 constant — strip case passes via count)
      // and small/sliver pieces (alpha 255 on few rows). For strips whose
      // alpha is ~50 (<100), also accept columns whose MEAN alpha > 35.
      const contentCols = [];
      for (let x = 0; x < PW; x++) {
        let opaque = 0, sum = 0;
        for (let y = 0; y < PH; y++) { const a = pcD[(y * PW + x) * 4 + 3]; if (a > 100) opaque++; sum += a; }
        if (opaque >= 3 || sum / PH > 35) contentCols.push(x);
      }
      // per-offset score: compare ONLY opaque rows (alpha>100) per column;
      // for low-alpha strip pieces (alpha~50), fall back to all rows.
      const rowsFor = (x) => {
        const rs = [];
        for (let y = 0; y < PH; y++) if (pcD[(y * PW + x) * 4 + 3] > 100) rs.push(y);
        if (rs.length < 3) { rs.length = 0; for (let y = 0; y < PH; y++) rs.push(y); }
        return rs;
      };
      const y0 = Math.floor(H * 0.08), y1 = Math.floor(H * 0.92);
      const scores = [];
      for (let off = 0; off + PW <= W; off++) {
        let sum = 0, n = 0;
        for (const x of contentCols) {
          const rs = rowsFor(x);
          for (const y of rs) {
            if (y < y0 || y >= y1) continue;
            sum += Math.abs(lumAt(pcD, PW, x, y) - lumAt(bgD, W, off + x, y)); n++;
          }
        }
        if (n) scores.push({ off, score: sum / n });
      }
      scores.sort((p, q) => p.score - q.score);
      // confidence: how much the best stands out vs the 15th percentile.
      // Flat curves (featureless region) = unreliable target → refresh.
      const qi = Math.min(scores.length - 1, Math.floor(scores.length * 0.15));
      const q = scores[qi] ? scores[qi].score : 1;
      const confidence = q > 0 ? (q - scores[0].score) / q : 0;
      return { PW, PH, contentCols: contentCols.length, confidence, best: scores.slice(0, 5), worst: scores.slice(-2) };
    }, { bgUri, pieceUri });
  };

  let match = await matchInPage();
  if (!match || !match.best || !match.best.length) {
    // piece may still be loading — one retry after 2.2s
    await sleep(2200);
    match = await matchInPage();
  }
  if (!match || !match.best || !match.best.length) { log('solve', 'match failed'); return false; }
  fs.writeFileSync(`${OUTDIR}/match.json`, JSON.stringify(match, null, 2));
  log('match', `best=${JSON.stringify(match.best.slice(0, 3))} worst=${JSON.stringify(match.worst || [])}`);

  let widthRefreshes = 0;
  for (let tryN = 1; tryN <= 10; tryN++) {
    // width gate: narrow pieces (<40px) have tiny drop tolerance — refresh (max 2)
    if ((match.PW || 0) > 0 && match.PW < 40 && widthRefreshes < 2 && tryN < 10) {
      widthRefreshes += 1;
      log('match', `narrow piece (${match.PW}px) — refreshing for a wider one (${widthRefreshes}/2)`);
      const refreshed = await clickFirst(page, ['[id*="aliyunCaptcha-btn-refresh"]', '[aria-label*="refresh" i]'], 'refresh');
      if (!refreshed) break;
      await sleep(2600);
      await dumpPopup(page, `narrow${tryN}`);
      match = await matchInPage();
      if (!match || !match.best || !match.best.length) break;
      continue;
    }
    // confidence gate: flat score curve = featureless region → refresh
    if (match.confidence != null && match.confidence < 0.06 && tryN < 10) {
      log('match', `low confidence (${(match.confidence * 100).toFixed(1)}%) — refreshing instead of dragging`);
      const refreshed = await clickFirst(page, ['[id*="aliyunCaptcha-btn-refresh"]', '[aria-label*="refresh" i]'], 'refresh');
      if (!refreshed) break;
      await sleep(2600);
      await dumpPopup(page, `conf${tryN}`);
      match = await matchInPage();
      if (!match || !match.best || !match.best.length) break;
      continue;
    }
    const targetLeft = match.best[0].off;
    const cx = handle.x + handle.w / 2, cy = handle.y + handle.h / 2;
    await page.mouse.move(cx, cy, { steps: 3 });
    await page.mouse.down();
    const readPiece = () => page.evaluate(() => {
      const el = document.querySelector('#aliyunCaptcha-puzzle');
      return el ? parseFloat(el.style.left) || 0 : null;
    });
    const pH = [];
    for (const h of [35, 140]) {
      await page.mouse.move(cx + h, cy + (Math.random() - 0.5) * 2, { steps: 8 });
      await sleep(250);
      pH.push([h, await readPiece()]);
    }
    const [h1, p1] = pH[0], [h2, p2] = pH[1];
    let a = 0, b = 0;
    if (p1 != null && p2 != null && h2 > h1) {
      const D = h1 * h2 * (h2 - h1);
      b = (p2 * h1 - p1 * h2) / D;
      a = (p1 - b * h1 * h1) / h1;
    }
    log('calib', `probes h=${h1}→p=${p1 && p1.toFixed(1)}, h=${h2}→p=${p2 && p2.toFixed(1)} ⇒ p = ${a.toFixed(4)}·h + ${b.toFixed(5)}·h²`);
    let hTarget;
    if (b > 1e-6) hTarget = (-a + Math.sqrt(a * a + 4 * b * targetLeft)) / (2 * b);
    else if (a > 1e-6) hTarget = targetLeft / a;
    else hTarget = targetLeft;
    hTarget = Math.max(8, Math.min(hTarget, 255));
    log('plan', `target pieceLeft=${targetLeft} ⇒ handle ${Math.round(hTarget)}px (try ${tryN})`);
    const steps = 34 + Math.floor(Math.random() * 12);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      await page.mouse.move(cx + eased * hTarget, cy + (Math.random() - 0.5) * 2.4, { steps: 1 });
      await page.waitForTimeout(10 + Math.random() * 20);
    }
    await page.mouse.move(cx + hTarget, cy + (Math.random() - 0.5), { steps: 2 });
    await page.waitForTimeout(350 + Math.random() * 380);
    await page.mouse.up();
    log('drag', `released at handle ${Math.round(hTarget)}px`);
    await sleep(2800);
    const after = await popupState(page);
    const okText = /success|verified|完成|成功/i.test((after.text || '') + (after.title || ''));
    if (!after.present || !after.visible || okText) { log('captcha', `SOLVED (try ${tryN})`); return true; }
    log('captcha', `try ${tryN} not solved: "${String(after.text).slice(0, 90)}"`);
    await page.screenshot({ path: `${OUTDIR}/fail_${tryN}.png` }).catch(() => {});
    const refreshed = await clickFirst(page, ['[id*="aliyunCaptcha-btn-refresh"]', '[aria-label*="refresh" i]', '[class*="refresh" i]'], 'refresh');
    if (!refreshed || tryN === 10) break;
    await sleep(2600);
    const nst = await dumpPopup(page, `retry${tryN}`);
    if (!nst.img) break;
    match = await matchInPage();
    if (match && match.best) log('match', `retry match: ${JSON.stringify(match.best.slice(0, 2))}`);
  }
  return false;
}

/* widget is in "start" state? (needs Click-to-start before solving) */
async function widgetNeedsStart(page) {
  return page.evaluate(() => {
    const t = document.querySelector('#aliyunCaptcha-captcha-text');
    const startBtn = document.querySelector('#aliyunCaptcha-captcha-left');
    if (!t && !startBtn) return false;
    const txt = (t && t.textContent) || '';
    return /Click to start verification|点击开始验证/i.test(txt) || !!(startBtn && startBtn.offsetParent);
  }).catch(() => false);
}

/* ---------------- form walk ---------------- */
async function formReport(page) {
  return page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return {
      url: location.href,
      heading: (document.querySelector('h1, h2, [class*="title"]') || {}).textContent || '',
      inputs: [...document.querySelectorAll('input')].filter(vis).map((i) => ({
        type: i.type, name: i.name, id: i.id, ph: i.placeholder, autocomplete: i.autocomplete,
      })),
      buttons: [...document.querySelectorAll('button')].filter(vis).map((b) => (b.textContent || '').trim().slice(0, 30)).filter(Boolean),
      links: [...document.querySelectorAll('a')].filter(vis).map((a) => (a.textContent || '').trim().slice(0, 30)).filter((t) => t && /sign|account|create/i.test(t)).slice(0, 6),
    };
  }).catch((e) => ({ err: e.message }));
}

async function clickFirst(page, sels, label) {
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count() && await loc.isVisible()) { await loc.click({ timeout: 4000 }); log('ui', `${label} via ${sel}`); return true; }
    } catch {}
  }
  return false;
}

/* ---------------- mail ---------------- */
async function mailList(email) {
  const r = await fetch(`${MAIL_API_BASE}/emails?address=${encodeURIComponent(email)}&limit=20&include_body=true`,
    { headers: { Authorization: `Bearer ${MAIL_API_TOKEN}`, Accept: 'application/json' } });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return await r.json();
}
async function pollVerifyLink(email, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const d = await mailList(email);
    for (const row of (d && d.results) || []) {
      const body = row.text_body || ''; const subj = row.subject || '';
      if (!/z\.ai|zai|chatglm|chat\.z/i.test(subj + ' ' + (row.from_header || ''))) continue;
      let m = (body.match(/https?:\/\/[^\s"']*chat\.z\.ai[^\s"']*/i) || [])[0];
      if (m) return { link: m, subject: subj };
    }
    await sleep(5000);
  }
  return { link: null, subject: 'timeout' };
}


/* expose to the requiring module (plain script, no ES exports) */
Object.assign(globalThis, {
  log, sleep, launchLocal, popupState, dumpPopup, livePositions,
  detectGap, humanDrag, solveWidget, widgetNeedsStart, formReport, clickFirst,
});
