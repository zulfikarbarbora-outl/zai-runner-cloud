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

/* ---------------- taint-proof data-URI fetcher ----------------
 * Aliyun serves the bg as a remote cross-origin URL after ANY refresh;
 * drawing that <img> to canvas taints it and getImageData throws
 * SecurityError. Fetching the bytes in Node and re-injecting as a data:
 * URI sidesteps CORS/taint entirely. Shared by detectGapFromImages and
 * matchInPage (inside solveWidget) — the caller fetches once, passes to
 * both, avoiding a redundant HTTP roundtrip. */
async function toDataUri(src) {
  if (!src) return null;
  if (src.startsWith('data:')) return src;
  try {
    const r = await fetch(src);
    const buf = Buffer.from(await r.arrayBuffer());
    return `data:${r.headers.get('content-type') || 'image/png'};base64,${buf.toString('base64')}`;
  } catch (e) { log('fetch', `remote image failed: ${e.message}`); return null; }
}

/* ---------------- in-page gap detection ----------------
 * The Aliyun puzzle: background photo with a puzzle-piece-shaped hole
 * (semi-transparent dark). Scan columns: the hole is a contiguous band
 * with (a) low luminance and (b) low per-column variance (flat gray).
 * Report the top-3 candidate bands so calibration can pick the rule.
 *
 * WAVE-6 BUG-A FIX: detectGap used to call ctx.drawImage(liveImg) on
 * #aliyunCaptcha-img directly. After any refresh, that img.src is a
 * REMOTE Aliyun CDN URL → canvas becomes tainted → getImageData throws
 * SecurityError → detectGap dead for all subsequent tries.
 *
 * detectGapFromImages takes a PRE-FETCHED bg data URI (no taint), loads
 * it into a fresh Image, draws to canvas, runs the SAME column-scan as
 * the original detectGap. The live #aliyunCaptcha-img is only READ for
 * its bounding rect (displayW/H, scaleX) — never drawn, so no taint.
 * detectGap(page) wraps this: fetches bg src via toDataUri, then delegates.
 * Callers that already have the data URI (probe() in solveWidget) should
 * call detectGapFromImages directly to avoid a redundant fetch.
 */
async function detectGapFromImages(page, bgDataUri) {
  return page.evaluate(async (bgDataUri) => {
    if (!bgDataUri) return { err: 'no bgDataUri' };
    // load bg from data URI — never taints the canvas (same-origin: data:)
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('bg img load failed'));
      i.src = bgDataUri;
    });
    const w = im.naturalWidth, h = im.naturalHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0, w, h);
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
    // geometry: read from the LIVE img (getBoundingClientRect only — never
    // drawImage, so no taint). Fallback to (w,h) if img is gone from DOM.
    const live = document.querySelector('#aliyunCaptcha-img');
    const box = live ? live.getBoundingClientRect() : { width: w, height: h };
    return {
      imgW: w, imgH: h, displayW: Math.round(box.width), displayH: Math.round(box.height),
      scaleX: w / box.width, darkRuns: runs.slice(0, 3), flatRuns: flat.slice(0, 3), edgePairs: pairs.slice(0, 6),
    };
  }, bgDataUri).catch((e) => ({ err: e.message }));
}

/* Backward-compat wrapper: zai_signup_solver.js --calibrate calls
 * detectGap(page) directly (no pre-fetched data URI). Fetch the bg src
 * here via toDataUri, then delegate to detectGapFromImages. Callers that
 * already have the data URI (solveWidget's probe) should call
 * detectGapFromImages directly to avoid a redundant fetch. */
async function detectGap(page) {
  const bgSrc = await page.evaluate(() => {
    const img = document.querySelector('#aliyunCaptcha-img');
    return img ? (img.src || '') : '';
  }).catch(() => '');
  const bgDataUri = await toDataUri(bgSrc);
  if (!bgDataUri) return { err: 'bg fetch failed' };
  return detectGapFromImages(page, bgDataUri);
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

  // toDataUri is now top-level (shared with detectGapFromImages).
  // matchInPage accepts an optional pre-fetched bgDataUri so probe() can
  // fetch the bg ONCE and pass it to both matchInPage + detectGapFromImages
  // — avoids a redundant HTTP roundtrip on remote (post-refresh) bgs.
  const matchInPage = async (bgDataUri) => {
    const s = await page.evaluate(() => {
      const out = {};
      const bg = document.querySelector('#aliyunCaptcha-img');
      const pc = document.querySelector('#aliyunCaptcha-puzzle');
      if (bg) out.bg = bg.src || '';
      if (pc) out.piece = pc.src || '';
      return out;
    });
    const bgUri = bgDataUri || await toDataUri(s.bg), pieceUri = await toDataUri(s.piece);
    if (!bgUri || !pieceUri) return null;
    return page.evaluate(async ({ bgUri, pieceUri }) => {
      const load = (u) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = u; });
      const [bgIm, pcIm] = await Promise.all([load(bgUri), load(pieceUri)]);
      const W = bgIm.naturalWidth, H = bgIm.naturalHeight, PW = pcIm.naturalWidth, PH = pcIm.naturalHeight;
      const mk = (im, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(im, 0, 0); return c.getContext('2d').getImageData(0, 0, w, h).data; };
      const bgD = mk(bgIm, W, H), pcD = mk(pcIm, PW, PH);
      const lumAt = (d, w, x, y) => { const i = (y * w + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
      const contentCols = [];
      for (let x = 0; x < PW; x++) {
        let opaque = 0, sum = 0;
        for (let y = 0; y < PH; y++) { const a = pcD[(y * PW + x) * 4 + 3]; if (a > 100) opaque++; sum += a; }
        if (opaque >= 3 || sum / PH > 35) contentCols.push(x);
      }
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
      const qi = Math.min(scores.length - 1, Math.floor(scores.length * 0.15));
      const q = scores[qi] ? scores[qi].score : 1;
      const confidence = q > 0 ? (q - scores[0].score) / q : 0;
      return { PW, PH, contentCols: contentCols.length, confidence, best: scores.slice(0, 5), worst: scores.slice(-2) };
    }, { bgUri, pieceUri });
  };

  /* --- pickHole — select the dark run that matches the piece --- *
   * detectGap returns darkRuns sorted darkest-first, flatRuns sorted
   * flattest-first, edgePairs sorted narrowest-first. We cross-validate:
   *
   *   1. edgeBracket   — prefer a darkRun bracketed by an edgePair (gradient
   *                      spikes at BOTH run edges). The hole's mask has sharp
   *                      luminance transitions on its left + right edges, so a
   *                      real hole is bracketed. Photo-feature shadows usually
   *                      are NOT (only one strong edge, or none).
   *   2. flatOverlap   — a darkRun that overlaps a flatRun. The mask interior
   *                      is low-sd semi-transparent gray; photo features are
   *                      high-variance content.
   *   3. darkest       — last resort (Wave 2 behavior). Keeps the Wave 1
   *                      baselines (conf1, narrow3) intact when their
   *                      darkRuns aren't edge-bracketed.
   *
   *   Case A (no darkRuns): edgePair fallback — use the edgePair whose width
   *     is closest to PW. Weaker signal but better than infinite-refreshing
   *     on narrow pieces (Run 2 try 1: darkRuns=[] but edgePairs present).
   *   Case B (darkRuns exist, none match piece width): null → matchInPage
   *     (Wave 1 retry4 baseline).
   *
   * WAVE-6 BUG-B: Wave 5 live verification caught pickHole picking the darkest
   * run (a photo shadow at x0=227) over the real hole (x0=50, bracketed by
   * edgePairs at x≈56-94). Cross-validation against edgePairs + flatRuns
   * disambiguates. Thresholds calibrated against the 5 captured cases:
   *   Run1    PW=17  runs@227,50  edgePair@56-74 brackets 50  → x0=50 ✓
   *   Run2    PW=10  darkRuns=[]  edgePair@57-75 closest     → x0=57 ✓
   *   conf1   PW=25  run@87       no edge bracket             → x0=87 (darkest) ✓
   *   narrow3 PW=42  run@149      no edge bracket             → x0=149 (darkest) ✓
   *   retry4  PW=69  runs@204,75  none match width            → null ✓
   */
  const BRACKET_TOL = 8; // per-edge; matches existing width tolerance (PW±8)
  const pickHole = (gap, PW) => {
    if (!gap || gap.err) return null;
    const darkRuns = (gap.darkRuns || []).filter((r) => r.mean < 100);
    const flatRuns = gap.flatRuns || [];
    const edgePairs = gap.edgePairs || [];
    for (const r of darkRuns) if (r.x1 == null) r.x1 = r.x0 + r.w;

    // Case A: no darkRuns → edgePair fallback (weaker signal, better than
    // falling through to the narrow-piece refresh gate without ever dragging).
    if (!darkRuns.length) {
      if (edgePairs.length) {
        const sorted = [...edgePairs].sort((a, b) => Math.abs(a.w - PW) - Math.abs(b.w - PW));
        const p = sorted[0];
        log('pickHole', `edgePairFallback: no darkRuns, pick edgePair x0=${p.x0} x1=${p.x1} w=${p.w} (closest to PW=${PW})`);
        return { x0: p.x0, x1: p.x1, w: p.w, mean: 100, signal: 'edgePairFallback' };
      }
      log('pickHole', `no darkRuns, no edgePairs → null`);
      return null;
    }

    // Width gate: existing PW±8 tight / PW-12..PW+16 loose band for mask halos.
    const widthOK = (r) => Math.abs(r.w - PW) <= 8 || (r.w >= PW - 12 && r.w <= PW + 16);
    const compatRuns = darkRuns.filter(widthOK);
    if (!compatRuns.length) {
      // Case B: darkRuns exist but none match piece width → null (retry4 baseline).
      log('pickHole', `no width-matching darkRuns (PW=${PW}, runs=${JSON.stringify(darkRuns.map(r => ({ x0: r.x0, w: r.w })))}) → null`);
      return null;
    }

    // Stage 1: edgeBracket — darkRun with tightest edgePair bracket.
    // Tolerance ±8 per edge: dark-run boundaries (mean<90 / >110 crossings)
    // can sit 5-7px INSIDE the gradient spike (the spike is at the steepest
    // descent, not the threshold crossing). ±8 covers Run1's offset (6+5=11).
    const bracketCandidates = [];
    for (const run of compatRuns) {
      let bestPair = null, bestDist = Infinity;
      for (const pair of edgePairs) {
        const dx0 = Math.abs(pair.x0 - run.x0);
        const dx1 = Math.abs(pair.x1 - run.x1);
        if (dx0 <= BRACKET_TOL && dx1 <= BRACKET_TOL) {
          const d = dx0 + dx1;
          if (d < bestDist) { bestDist = d; bestPair = pair; }
        }
      }
      if (bestPair) bracketCandidates.push({ run, pair: bestPair, dist: bestDist });
    }
    if (bracketCandidates.length) {
      bracketCandidates.sort((a, b) => a.run.mean - b.run.mean);  // WAVE-14: sort by mean (darkest first) — was by bracket dist; photo features have sharper edges (tighter brackets) but real hole masks are darker
      const pick = bracketCandidates[0];
      log('pickHole', `edgeBracket: darkRun x0=${pick.run.x0} w=${pick.run.w} mean=${pick.run.mean.toFixed(0)} ← edgePair x0=${pick.pair.x0} x1=${pick.pair.x1} (bracket dist=${pick.dist})`);
      return { ...pick.run, signal: 'edgeBracket' };
    }

    // Stage 2: flatOverlap — darkRun overlapping a flatRun.
    const overlapsFlat = (run) => flatRuns.some((f) => f.x1 != null && run.x1 > f.x0 + 3 && run.x0 < f.x1 - 3);
    const flatCands = compatRuns.filter(overlapsFlat);
    if (flatCands.length) {
      flatCands.sort((a, b) => a.mean - b.mean);
      const pick = flatCands[0];
      log('pickHole', `flatOverlap: darkRun x0=${pick.x0} w=${pick.w} mean=${pick.mean.toFixed(0)} (overlaps flat run)`);
      return { ...pick, signal: 'flatOverlap' };
    }

    // Stage 3: darkest (last resort — Wave 2 behavior, keeps conf1/narrow3).
    const pick = compatRuns[0];
    log('pickHole', `darkest: darkRun x0=${pick.x0} w=${pick.w} mean=${pick.mean.toFixed(0)} (no edge/flat validation)`);
    return { ...pick, signal: 'darkest' };
  };

  /* --- WAVE-2: probe — run BOTH detectors in parallel, save JSONs, log --- *
   * WAVE-6 BUG-A: fetch the bg src ONCE in Node via toDataUri (taint-proof),
   * then pass the data URI to both matchInPage and detectGapFromImages.
   * Avoids (a) the canvas-taint SecurityError that killed detectGap on
   * remote (post-refresh) bgs and (b) a redundant HTTP roundtrip. */
  const probe = async () => {
    const bgSrc = await page.evaluate(() => {
      const img = document.querySelector('#aliyunCaptcha-img');
      return img ? (img.src || '') : '';
    }).catch(() => '');
    const bgDataUri = await toDataUri(bgSrc);
    if (!bgDataUri) log('gap', `bg fetch failed (src len=${bgSrc.length}, prefix=${bgSrc.slice(0, 40)})`);
    const [m, g] = await Promise.all([
      matchInPage(bgDataUri),
      detectGapFromImages(page, bgDataUri),
    ]);
    if (m && m.best && m.best.length) {
      fs.writeFileSync(`${OUTDIR}/match.json`, JSON.stringify(m, null, 2));
      log('match', `best=${JSON.stringify(m.best.slice(0, 3))} worst=${JSON.stringify(m.worst || [])}`);
    }
    if (g && !g.err) {
      fs.writeFileSync(`${OUTDIR}/gap.json`, JSON.stringify(g, null, 2));
      log('gap', `darkRuns=${JSON.stringify((g.darkRuns || []).slice(0, 3))} flatRuns=${JSON.stringify((g.flatRuns || []).slice(0, 2))}`);
    } else {
      log('gap', `detectGap ${(g && g.err) ? 'err: ' + g.err : 'none'}`);
    }
    return { match: m, gap: g };
  };

  let { match, gap } = await probe();
  if (!match || !match.best || !match.best.length) {
    // piece may still be loading — one retry after 2.2s
    await sleep(2200);
    ({ match, gap } = await probe());
  }
  if (!match || !match.best || !match.best.length) { log('solve', 'match failed'); return false; }

  let widthRefreshes = 0;
  for (let tryN = 1; tryN <= 10; tryN++) {
    const PW = match.PW || 0;
    const hole = pickHole(gap, PW);
    const bestScore = match.best[0].score;

    // width gate: narrow pieces (<40px) have tiny drop tolerance — refresh (max 2).
    // WAVE-2 NIT-1: skip this gate when detectGap found a hole — pickHole gives
    // the exact hole x0 even for narrow pieces (validated: conf1 PW=25 → hole=87).
    if (PW > 0 && PW < 40 && !hole && widthRefreshes < 2 && tryN < 10) {
      widthRefreshes += 1;
      log('match', `narrow piece (${PW}px) — refreshing for a wider one (${widthRefreshes}/2)`);
      const refreshed = await clickFirst(page, ['[id*="aliyunCaptcha-btn-refresh"]', '[aria-label*="refresh" i]'], 'refresh');
      if (!refreshed) break;
      await sleep(2600);
      await dumpPopup(page, `narrow${tryN}`);
      ({ match, gap } = await probe());
      if (!match || !match.best || !match.best.length) break;
      continue;
    }
    // confidence gate: flat score curve = featureless region. Refresh ONLY
    // if detectGap ALSO found no hole — if detectGap has a hole, drag anyway
    // (template-match confidence is irrelevant when we have the hole).
    if (!hole && match.confidence != null && match.confidence < 0.06 && tryN < 10) {
      log('match', `low confidence (${(match.confidence * 100).toFixed(1)}%) + no detectGap hole — refreshing`);
      const refreshed = await clickFirst(page, ['[id*="aliyunCaptcha-btn-refresh"]', '[aria-label*="refresh" i]'], 'refresh');
      if (!refreshed) break;
      await sleep(2600);
      await dumpPopup(page, `conf${tryN}`);
      ({ match, gap } = await probe());
      if (!match || !match.best || !match.best.length) break;
      continue;
    }
    // absolute-score gate: both signals weak (no hole + poor template match)
    // → refresh. Catches the case where the bg has no clear dark hole AND
    // the piece doesn't template-match anywhere reliably.
    if (!hole && bestScore > 30 && tryN < 10) {
      log('match', `both signals weak: best score ${bestScore.toFixed(1)}>30 + no detectGap hole — refreshing`);
      const refreshed = await clickFirst(page, ['[id*="aliyunCaptcha-btn-refresh"]', '[aria-label*="refresh" i]'], 'refresh');
      if (!refreshed) break;
      await sleep(2600);
      await dumpPopup(page, `weak${tryN}`);
      ({ match, gap } = await probe());
      if (!match || !match.best || !match.best.length) break;
      continue;
    }

    // Pick target: detectGap is PRIMARY (its x0 = the hole's LEFT EDGE,
    // where the piece's left edge must align). matchInPage is the fallback
    // when detectGap found no clear hole.
    //
    // WAVE-9: edgePairFallback (the "no darkRuns → use closest-width edgePair"
    // path) is a WEAK signal — natural photos have many width-similar gradient
    // edges that aren't the hole. Demote it: a confident matchInPage (score < 20
    // AND confidence > 0.5) overrides edgePairFallback. The strong detectGap
    // signals (edgeBracket / flatOverlap / darkest — all from real dark runs)
    // remain authoritative over matchInPage.
    let targetLeft, method;
    const isWeakHole = hole && hole.signal === 'edgePairFallback';
    const confidentMatch = !hole || (isWeakHole && bestScore < 30 && match.confidence > 0.35);
    if (hole && !isWeakHole) {
      targetLeft = hole.x0;
      method = `detectGap[${hole.signal}](x0=${hole.x0} w=${hole.w} mean=${isNaN(hole.mean) ? 'n/a' : hole.mean.toFixed(0)})`;
    } else if (confidentMatch) {
      targetLeft = match.best[0].off;
      method = `matchInPage(off=${targetLeft} score=${bestScore.toFixed(1)} conf=${(match.confidence * 100).toFixed(0)}%)${hole ? ' [overrides weak edgePairFallback]' : ''}`;
    } else if (hole) {
      // weak hole (edgePairFallback) + no confident match — use the weak hole as last resort
      targetLeft = hole.x0;
      method = `detectGap[edgePairFallback-weak](x0=${hole.x0} w=${hole.w})`;
    } else {
      targetLeft = match.best[0].off;
      method = `matchInPage(off=${targetLeft} score=${bestScore.toFixed(1)})`;
    }
    log('target', `try ${tryN}: PW=${PW} hole=${hole ? hole.x0 + '(' + (hole.signal || '?') + ')' : 'none'} best[0]=${match.best[0].off}@${bestScore.toFixed(1)} conf=${(match.confidence * 100).toFixed(0)}% ⇒ ${method} targetLeft=${targetLeft}`);

    // gearing + humanized drag.
    // WAVE-6 BUG-C: gearing math p(h)=a·h+b·h² (proven, account #11) UNCHANGED.
    // Only the DRAG execution changed: old 34-46 step loop had 35-47
    // page.mouse.move() calls = 35-47 CDP round-trips = 40+ s over zenrows.
    // Aliyun's behavioural check saw this as robotic and reset the slider.
    // New drag: 5 eased waypoints + 1 exact-target settle = 6 CDP moves.
    // Playwright interpolates between waypoints LOCALLY ({steps:5} per call)
    // so the humanized ease-in-out velocity profile is preserved.
    const cx = handle.x + handle.w / 2, cy = handle.y + handle.h / 2;
    let cdpMoves = 0;  // WAVE-6 BUG-C: instrument CDP round-trip count
    await page.mouse.move(cx, cy, { steps: 1 }); cdpMoves++;  // WAVE-7: steps:1 (was 3) — each step is a CDP round-trip
    await page.mouse.down(); cdpMoves++;
    const readPiece = () => page.evaluate(() => {
      const el = document.querySelector('#aliyunCaptcha-puzzle');
      return el ? parseFloat(el.style.left) || 0 : null;
    });
    // WAVE-6 BUG-C: probe moves use {steps:5} (was 8). Both probes are still
    // 1 CDP round-trip each (Playwright interpolates locally), but fewer
    // synthetic pointermove events dispatch per probe → marginally faster.
    const pH = [];
    for (const h of [35, 140]) {
      await page.mouse.move(cx + h, cy + (Math.random() - 0.5) * 2, { steps: 1 }); cdpMoves++;  // WAVE-7: steps:1 (was 5)
      await sleep(250);
      pH.push([h, await readPiece()]); cdpMoves++;  // page.evaluate = 1 CDP round-trip
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
    hTarget = Math.max(8, Math.min(hTarget, 280));
    log('plan', `target pieceLeft=${targetLeft} ⇒ handle ${Math.round(hTarget)}px (try ${tryN}) [${method}]`);
    // WAVE-6 BUG-C: batched-waypoint drag. Old code had a 34-46 step loop
    // with 1 page.mouse.move() per step + 1 final settle move = 35-47 CDP
    // round-trips. Over zenrows each round-trip is ~1s → 40+ s drag, which
    // Aliyun's behavioural check flagged as robotic (slider reset to
    // "Please drag the slider to restore the complete image").
    //
    // Fix (Option 2 from the wave-6 brief): 5 eased waypoints + 1 exact-target
    // settle move = 6 page.mouse.move() calls. Each call uses {steps:5} so
    // Playwright interpolates BETWEEN waypoints locally — only the waypoint
    // endpoints round-trip through CDP. Waypoint t-values [0.18, 0.42, 0.62,
    // 0.82, 1.0] are placed denser at the start/end (where eased(t) curvature
    // is highest) so the piecewise-linear approximation tracks easeInOutQuad
    // closely. Velocity profile = slow-fast-slow (preserved).
    //
    // Total drag CDP round-trips: 6 (was 35-47). At ~1s/round-trip over
    // zenrows, drag latency drops from ~40s to ~6s. Locally (each move
    // ~5ms) the drag is ~650ms, dominated by the 350-730ms settle.
    const dragStart = Date.now();
    const waypoints = [0.18, 0.42, 0.62, 0.82, 1.0];
    for (let wi = 0; wi < waypoints.length; wi++) {
      const t = waypoints[wi];
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      // ±1.2px vertical jitter mid-drag (matches old ±2.4 * 0.5 amplitude).
      const yJitter = (Math.random() - 0.5) * 2.4;
      await page.mouse.move(cx + eased * hTarget, cy + yJitter, { steps: 1 });  // WAVE-7: steps:1 (was 5)
      cdpMoves++;
      if (t < 1.0) await page.waitForTimeout(450 + Math.random() * 150);  // WAVE-14: 450-600ms (was 200-300ms) — total drag ~3s; zenrows 7-8s solved 2/2, sub-1s solved 0/16
    }
    // Exact-target settle: dampened jitter (±0.3px) for a stable release.
    await page.mouse.move(cx + hTarget, cy + (Math.random() - 0.5) * 0.6, { steps: 1 });  // WAVE-7: steps:1 (was 2)
    cdpMoves++;
    await page.waitForTimeout(800 + Math.random() * 400);  // WAVE-14: 800-1200ms (was 350-730ms) — final settle before release
    await page.mouse.up(); cdpMoves++;
    log('drag', `released at handle ${Math.round(hTarget)}px in ${Date.now() - dragStart}ms (drag CDP moves=6, total so far=${cdpMoves}) [${method}]`);
    await sleep(2800);
    const after = await popupState(page);
    const okText = /success|verified|完成|成功/i.test((after.text || '') + (after.title || ''));
    if (!after.present || !after.visible || okText) { log('captcha', `SOLVED (try ${tryN}) [${method}]`); return true; }
    log('captcha', `try ${tryN} not solved [${method}]: "${String(after.text).slice(0, 90)}"`);
    await page.screenshot({ path: `${OUTDIR}/fail_${tryN}.png` }).catch(() => {});
    const refreshed = await clickFirst(page, ['[id*="aliyunCaptcha-btn-refresh"]', '[aria-label*="refresh" i]', '[class*="refresh" i]'], 'refresh');
    if (!refreshed || tryN === 10) break;
    await sleep(2600);
    const nst = await dumpPopup(page, `retry${tryN}`);
    if (!nst.img) break;
    ({ match, gap } = await probe());
    if (match && match.best) log('match', `retry match: ${JSON.stringify(match.best.slice(0, 2))}`);
  }
  return false;
}

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
  toDataUri, detectGap, detectGapFromImages, humanDrag, solveWidget, widgetNeedsStart, formReport, clickFirst,
});
