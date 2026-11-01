/* ATLAS / GHOST — v0.2 frontend. Static; live mode via the optional Worker. */
(() => {
  'use strict';
  const C = window.AtlasCore;
  const cfg = Object.assign({ apiBase: '', turnstileSiteKey: '', viewerMode: false, contractAddress: '', xHandle: '' }, window.ATLAS_CONFIG || {});
  cfg.features = Object.assign({ deep: true, parallel: true, paper: true }, cfg.features || {});
  // viewerMode: for hosts that block file downloads and the share sheet (e.g. an embedded viewer).
  // The card is shown as an image to save manually, and Share copies plain text with no link.
  const viewer = cfg.viewerMode === true;
  // Back-compat with v0.1 config.js
  if (!cfg.apiBase && typeof window.ATLAS_API_BASE === 'string') cfg.apiBase = window.ATLAS_API_BASE;
  const apiBase = /^https:\/\/[^\s/]+(\/[^\s]*)?$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cfg.apiBase) ? cfg.apiBase.replace(/\/+$/, '') : '';
  const liveEnabled = !!apiBase;

  const $ = id => document.getElementById(id);
  const form = $('ghost-form'), wallet = $('wallet'), button = $('analyze'), result = $('result'), errorBox = $('error');
  const liveRadio = $('mode-live'), liveNote = $('live-note');
  const BUTTON_LABEL = 'SUMMON MY GHOST <span aria-hidden="true">↗</span>';
  let busy = false, turnstileToken = '', turnstileWidget = null;

  const DEMO = {
    mode: 'demo', archetype: 'chart-chaser', title: 'THE CHART CHASER', identity: 'SAMPLE WALLET',
    stats: [{ label: 'RECENT SWAPS', value: '24' }, { label: 'SWAP-DAY COUNT', value: '8' }, { label: 'RECENT TXS', value: '47' }],
    roast: '“That green candle was not an invitation. It was a warning with great marketing.”',
    insight: 'The fictional demo wallet made frequent swaps across a small number of active days. That pattern might deserve a closer look before assuming it reflects a consistent strategy.',
    evidence: ['24 simulated swaps in a sample of 47 invented transactions', 'Trading activity spread across 8 sample calendar days', 'Sample data only; not tied to any blockchain wallet'],
    disclosure: 'SAMPLE / FICTIONAL NUMBERS — No real wallet or market data was analyzed.',
  };

  // ---------- onboarding state ----------
  function setStep(n) {
    $('step-tag').textContent = `STEP ${n} OF 3`;
    document.querySelectorAll('.steps li').forEach(li => {
      const s = Number(li.dataset.step);
      li.classList.toggle('active', s === n);
      li.classList.toggle('done', s < n);
    });
  }
  const mode = () => (document.querySelector('input[name="mode"]:checked') || {}).value || 'demo';

  if (!liveEnabled || cfg.features.deep === false) { const d = $('deep-option'); if (d) d.classList.add('hidden'); }
  if (!liveEnabled) {
    liveRadio.disabled = true;
    $('live-option').classList.add('disabled');
    liveNote.textContent = 'Not enabled on this site yet — the sample roast works without it';
  }

  function showError(message) { errorBox.textContent = message; errorBox.classList.remove('hidden'); }
  function clearError() { errorBox.textContent = ''; errorBox.classList.add('hidden'); }

  // Paste/typing a valid address switches to live automatically (when available).
  wallet.addEventListener('input', () => {
    clearError();
    const kind = C.classifyInput(wallet.value);
    if (kind === 'secret') {
      wallet.value = '';
      showError('That looks like a private key or seed phrase. It was cleared and NOT sent anywhere. Only paste a public wallet address — and consider that secret compromised if you pasted it somewhere untrusted.');
      return;
    }
    if (kind === 'address') {
      if (liveEnabled) { liveRadio.checked = true; onModeChange(); }
      else showError('Live wallet analysis is not enabled on this site yet. You can still try the sample roast.');
    }
  });
  document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', onModeChange));
  function onModeChange() {
    clearError();
    if (mode() === 'live') { setStep(2); ensureTurnstile(); }
  }

  // ---------- optional Turnstile ----------
  function ensureTurnstile() {
    if (!cfg.turnstileSiteKey || !liveEnabled || turnstileWidget !== null) return;
    turnstileWidget = 'loading';
    const box = $('turnstile');
    box.classList.remove('hidden');
    window.atlasTurnstileReady = () => {
      turnstileWidget = window.turnstile.render(box, {
        sitekey: cfg.turnstileSiteKey, theme: 'dark',
        callback: t => { turnstileToken = t; }, 'expired-callback': () => { turnstileToken = ''; },
      });
    };
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=atlasTurnstileReady';
    s.async = true; s.defer = true;
    s.onerror = () => { turnstileWidget = null; showError('Human verification could not load. Live mode needs it; the sample roast still works.'); };
    document.head.appendChild(s);
  }

  // ---------- rendering ----------
  function render(raw, { focus = true } = {}) {
    const r = C.normalizeReport(raw);
    if (!r) { showError('GHOST returned a report in an unexpected format. Nothing was shown.'); return null; }
    result.innerHTML = C.renderReportHtml(r);
    if (viewer) {
      $('save').textContent = '▣ Show share card';
      $('share').textContent = 'Copy roast text';
    }
    $('save').addEventListener('click', () => (viewer ? showCardPreview(r) : downloadCard(r)));
    $('share').addEventListener('click', () => shareReport(r));
    if (focus) {
      const title = $('result-title');
      title.focus({ preventScroll: true });
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      result.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
    return r;
  }

  function fetchWithTimeout(url, opts, ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return fetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(ms) }));
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(() => clearTimeout(t));
  }

  async function runLive(address) {
    const deepBox = $('deep');
    const depth = deepBox && deepBox.checked && cfg.features.deep !== false ? 'deep' : 'quick';
    const body = depth === 'deep' ? { address, depth } : { address };
    if (cfg.turnstileSiteKey) {
      if (!turnstileToken) { showError('Please complete the quick human check above, then press the button again.'); return; }
      body.turnstileToken = turnstileToken;
    }
    let res;
    try {
      res = await fetchWithTimeout(apiBase + '/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer',
      }, depth === 'deep' ? 45000 : 18000);
    } catch (e) {
      showError(C.friendlyError(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 0));
      return;
    } finally {
      if (cfg.turnstileSiteKey && window.turnstile && turnstileWidget && turnstileWidget !== 'loading') { window.turnstile.reset(turnstileWidget); turnstileToken = ''; }
    }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) { try { data = await res.json(); } catch { data = null; } }
    if (!res.ok) { showError(C.friendlyError(res.status, data && data.error)); return; }
    if (!data) { showError('GHOST returned a response that was not a report. Nothing was shown.'); return; }
    if (render(data)) {
      setStep(3);
      if (data.deep) {
        // Hand the deep memory to the Lab; key = hash of the address, so the browser can compare with last time without storing the address.
        let key = '';
        try {
          const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
          key = [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch { /* no comparison then */ }
        window.dispatchEvent(new CustomEvent('ghost:deep', { detail: { deep: data.deep, key } }));
      }
    }
  }

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (busy) return;
    clearError();
    if (mode() === 'demo') {
      render(Object.assign({}, DEMO, { createdAt: new Date().toISOString() }));
      setStep(liveEnabled ? 2 : 3);
      return;
    }
    if (!liveEnabled) { showError('Live wallet analysis is not enabled on this site yet. Try the sample roast.'); return; }
    const kind = C.classifyInput(wallet.value);
    if (kind === 'secret') { wallet.value = ''; showError('That looks like a private key or seed phrase. It was cleared and NOT sent. Only paste a public address.'); return; }
    const address = wallet.value.trim();
    if (kind !== 'address') { showError('Enter a valid Solana public wallet address (base58, 32–44 characters). Never enter your private key.'); wallet.focus(); return; }
    busy = true; button.disabled = true; button.textContent = $('deep') && $('deep').checked ? 'READING YOUR HISTORY…' : 'READING PUBLIC TRANSACTIONS…'; result.setAttribute('aria-busy', 'true');
    try { await runLive(address); }
    finally { busy = false; button.disabled = false; button.innerHTML = BUTTON_LABEL; result.setAttribute('aria-busy', 'false'); }
  });

  // ---------- share card ----------
  const SPECIMEN = { 'chart-chaser': 'GH-00', 'rapid-clicker': 'GH-01', 'burst-trader': 'GH-02', 'failure-collector': 'GH-03', 'on-chain-explorer': 'GH-04', 'quiet-observer': 'GH-05', 'mystery-wallet': 'GH-06' };
  const GHOST_PATH = 'M200 58c-70 0-104 56-104 118v138l30-20 26 22 24-22 24 22 24-22 26 22 30-20V176c0-62-34-118-104-118Z';

  async function ensureFonts() {
    if (!document.fonts || !document.fonts.load) return;
    try {
      await Promise.all(['900 52px Archivo', '800 30px Archivo', '700 16px "JetBrains Mono"', '400 16px "JetBrains Mono"'].map(f => document.fonts.load(f)));
    } catch { /* fall back to system fonts */ }
  }

  function drawCard(r) {
    const W = 1200, H = 630, X = 64;
    const INK = '#07080b', TEXT = '#eef0f6', MUTED = '#9aa1b3', ACCENT = '#64efdb', LINE = '#1c2130', LINE2 = '#2b3245';
    const D = 'Archivo, "Arial Black", Arial, sans-serif', M = '"JetBrains Mono", ui-monospace, Menlo, monospace';
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const mono = (txt, x, y, size, color, weight = 700, align = 'left') => {
      g.font = `${weight} ${size}px ${M}`; g.fillStyle = color; g.textAlign = align;
      if ('letterSpacing' in g) g.letterSpacing = `${Math.round(size * 0.14)}px`;
      g.fillText(txt, x, y);
      if ('letterSpacing' in g) g.letterSpacing = '0px';
      g.textAlign = 'left';
    };
    const display = (size, weight = 900) => { g.font = `${weight} ${size}px ${D}`; if ('fontStretch' in g) g.fontStretch = 'semi-expanded'; };

    g.fillStyle = INK; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#ffffff07'; g.lineWidth = 1;
    for (let x = 0; x <= W; x += 75) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, H); g.stroke(); }
    for (let y = 0; y <= H; y += 75) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(W, y + .5); g.stroke(); }
    g.strokeStyle = LINE2; g.strokeRect(24.5, 24.5, W - 49, H - 49);

    // brand
    g.strokeStyle = ACCENT; g.lineWidth = 1.5; g.beginPath(); g.arc(X + 18, 72, 18, 0, Math.PI * 2); g.stroke();
    mono('GH', X + 18, 76, 11, ACCENT, 700, 'center');
    mono('GHOST', X + 50, 78, 17, TEXT);
    mono(`SPECIMEN / ${SPECIMEN[r.archetype] || 'GH-??'}`, W - X, 78, 13, MUTED, 400, 'right');

    // ghost
    const glow = g.createRadialGradient(1010, 250, 10, 1010, 250, 190);
    glow.addColorStop(0, '#26306e'); glow.addColorStop(1, '#07080b00');
    g.fillStyle = glow; g.fillRect(800, 60, 400, 380);
    g.strokeStyle = LINE2; g.lineWidth = 1; g.beginPath(); g.arc(1010, 255, 150, 0, Math.PI * 2); g.stroke();
    g.save(); g.translate(1010 - 200 * .62, 255 - 210 * .62); g.scale(.62, .62);
    const body = g.createLinearGradient(96, 58, 304, 336);
    body.addColorStop(0, '#73F6E1'); body.addColorStop(.5, '#8098ff'); body.addColorStop(1, '#cd77ff');
    g.fillStyle = body; g.fill(new Path2D(GHOST_PATH));
    g.strokeStyle = '#0d0b1f'; g.lineCap = 'round'; g.lineWidth = 9;
    g.beginPath(); g.moveTo(146, 174); g.quadraticCurveTo(162, 162, 178, 174); g.stroke();
    g.fillStyle = '#0d0b1f'; g.beginPath(); g.ellipse(240, 178, 15, 22, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(245, 170, 4.5, 0, Math.PI * 2); g.fill();
    g.lineWidth = 8; g.beginPath(); g.moveTo(172, 236); g.quadraticCurveTo(200, 256, 230, 230); g.stroke();
    g.restore();

    // label + title
    mono(r.mode === 'demo' ? 'SAMPLE REPORT / FICTIONAL NUMBERS' : 'LIVE / LATEST PAGE / PARTIAL', X, 160, 14, ACCENT);
    const TW = 740;
    let size = 64;
    do { display(size); size -= 2; } while (g.measureText(r.title).width > TW && size > 26);
    g.fillStyle = TEXT; g.fillText(r.title, X, 236);

    // stats
    const cols = r.stats.slice(0, 3), cw = TW / 3;
    g.strokeStyle = LINE2; g.strokeRect(X + .5, 268.5, TW, 96);
    cols.forEach((s, i) => {
      const x = X + i * cw;
      if (i) { g.beginPath(); g.moveTo(x + .5, 268); g.lineTo(x + .5, 364); g.stroke(); }
      display(44); g.fillStyle = TEXT; g.fillText(s.value, x + 18, 320);
      mono(s.label, x + 18, 348, 11, MUTED, 400);
    });

    // roast
    display(30, 800); if ('fontStretch' in g) g.fontStretch = 'normal';
    const lines = C.wrapText(t => g.measureText(t).width, r.roast.replace(/[“”]/g, ''), W - X * 2 - 30, 3);
    const bar = g.createLinearGradient(0, 410, 0, 424 + lines.length * 42); bar.addColorStop(0, '#64efdb'); bar.addColorStop(1, '#cd77ff');
    g.fillStyle = bar; g.fillRect(X, 410, 3, 14 + lines.length * 42);
    g.fillStyle = TEXT;
    lines.forEach((l, i) => g.fillText(l, X + 24, 440 + i * 42));

    // footer
    g.strokeStyle = LINE; g.beginPath(); g.moveTo(X, 556.5); g.lineTo(W - X, 556.5); g.stroke();
    const foot = r.mode === 'demo' ? 'DEMO ONLY / NOT REAL TRADING RESULTS'
      : `LATEST PAGE${r.window ? ` ${r.window.start} → ${r.window.end} UTC` : ''} / NOT P&L`;
    mono(foot, X, 590, 12, MUTED, 400);
    mono('YOUR WALLET HAS A GHOST.', W - X, 590, 13, '#cd77ff', 700, 'right');
    return c;
  }

  async function cardBlob(r) {
    await ensureFonts();
    const c = drawCard(r);
    return new Promise(resolve => c.toBlob(b => resolve(b), 'image/png'));
  }
  const cardName = r => `ghost-${r.archetype || r.mode}.png`;

  async function downloadCard(r) {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch { /* ignore */ } }
    const blob = await cardBlob(r);
    if (!blob) { showError('Your browser could not create the image.'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = cardName(r); a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function showCardPreview(r) {
    await ensureFonts();
    let box = $('card-preview');
    if (!box) {
      box = document.createElement('figure');
      box.className = 'card-preview'; box.id = 'card-preview';
      box.innerHTML = '<img id="card-preview-img" alt="" width="1200" height="630" /><figcaption>Right-click (desktop) or long-press (phone) the image to save it.</figcaption>';
      result.appendChild(box);
    }
    const img = $('card-preview-img');
    img.src = drawCard(r).toDataURL('image/png');
    img.alt = `GHOST share card: ${r.title}`;
    box.scrollIntoView({ block: 'nearest' });
  }

  async function copyText(btn, label, msg) {
    try {
      await navigator.clipboard.writeText(msg);
      btn.textContent = 'Copied! ✓';
      setTimeout(() => { btn.textContent = label; }, 2500);
    } catch { showManualCopy(msg); }
  }

  async function shareReport(r) {
    if (viewer) {
      const s = r.stats.slice(0, 3).map(x => `${x.value} ${x.label.toLowerCase()}`).join(', ');
      return copyText($('share'), 'Copy roast text', `GHOST says I'm ${r.title} (${s}). ${r.roast}${r.mode === 'demo' ? ' (sample report)' : ''}`);
    }
    const link = C.buildShareUrl(location.href, r);
    const text = `My trading history just got roasted by GHOST — I'm ${r.title}. Can yours survive?`;
    const btn = $('share');
    // Mobile: native share sheet with the PNG attached. Only build the image when a share
    // sheet exists, so desktop copies instantly while the click still counts as a user gesture.
    if (navigator.share) {
      try {
        const blob = navigator.canShare ? await cardBlob(r) : null;
        const file = blob && typeof File === 'function' ? new File([blob], cardName(r), { type: 'image/png' }) : null;
        if (file && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], text, url: link });
        else await navigator.share({ text, url: link });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user closed the share sheet
      }
    }
    const msg = `${text} ${link}`;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(msg);
        btn.textContent = 'Copied! ✓';
        setTimeout(() => { btn.textContent = 'Share challenge ↗'; }, 2500);
        return;
      }
    } catch { /* fall through to manual copy */ }
    showManualCopy(msg);
  }

  function showManualCopy(msg) {
    let box = $('manual-copy');
    if (!box) {
      box = document.createElement('div');
      box.className = 'manual-copy'; box.id = 'manual-copy';
      box.innerHTML = '<label for="manual-copy-input">Copy this challenge:</label><input id="manual-copy-input" readonly />';
      result.appendChild(box);
    }
    const input = $('manual-copy-input');
    input.value = msg; input.focus(); input.select();
  }

  // ---------- contract address + X link (both optional, from config.js) ----------
  const ca = typeof cfg.contractAddress === 'string' ? cfg.contractAddress.trim() : '';
  if (ca && C.isValidSolanaAddress(ca)) {
    $('ca-label').textContent = 'OFFICIAL CONTRACT ADDRESS / CLICK TO COPY';
    $('ca-value').textContent = ca;
    const copyBtn = $('ca-copy');
    copyBtn.classList.remove('hidden');
    const doCopy = async () => {
      try { await navigator.clipboard.writeText(ca); copyBtn.textContent = 'COPIED'; setTimeout(() => { copyBtn.textContent = 'COPY'; }, 2000); }
      catch { const sel = window.getSelection(); const rng = document.createRange(); rng.selectNodeContents($('ca-value')); sel.removeAllRanges(); sel.addRange(rng); }
    };
    copyBtn.addEventListener('click', doCopy);
    $('ca-value').addEventListener('click', doCopy);
    $('ca-note').textContent = 'MATCH EVERY CHARACTER BEFORE TRADING. ONLY TRUST THIS SITE AND THE OFFICIAL X ACCOUNT. IGNORE DMS.';
    $('footer-note').textContent = 'MEME COIN · NO UTILITY OR RETURNS PROMISED · LIVE DATA COVERS ONE RECENT PAGE · NOT FINANCIAL ADVICE';
  }
  const handle = typeof cfg.xHandle === 'string' ? cfg.xHandle.trim().replace(/^@/, '') : '';
  if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    const xl = $('nav-x');
    xl.href = `https://x.com/${handle}`;
    $('nav-x-handle').textContent = '@' + handle.toUpperCase();
    xl.classList.remove('hidden');
    const fb = $('follow-btn');
    fb.href = `https://x.com/${handle}`; fb.target = '_blank'; fb.rel = 'noopener';
    fb.innerHTML = 'FOLLOW THE GHOST <span aria-hidden="true">↗</span>';
  }

  // ---------- hero parallax: the ghost leans toward the pointer ----------
  const art = document.querySelector('.hero-art'), ring = document.querySelector('.ring');
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (art && ring && !still && window.matchMedia('(pointer: fine)').matches) {
    window.addEventListener('pointermove', e => {
      const r = art.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth, dy = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
      ring.style.setProperty('--px', `${(dx * 18).toFixed(1)}px`);
      ring.style.setProperty('--py', `${(dy * 18).toFixed(1)}px`);
    }, { passive: true });
  }

  // ---------- focus-in headlines (only below the fold, only with motion allowed) ----------
  if ('IntersectionObserver' in window && !still) {
    const items = [...document.querySelectorAll('.reveal')].filter(el => el.getBoundingClientRect().top > window.innerHeight);
    if (items.length) {
      document.documentElement.classList.add('js-reveal');
      document.querySelectorAll('.reveal').forEach(el => { if (!items.includes(el)) el.classList.add('in'); });
      const io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: .25 });
      items.forEach(el => io.observe(el));
    }
  }

  // ---------- invite banner from a share link (archetype only) ----------
  const invited = C.parseShareHash(location.hash);
  if (invited) {
    const inv = $('invite');
    inv.textContent = `A friend got ${C.ARCHETYPES[invited]}. Think your wallet can do better? Start with the sample — it takes one tap.`;
    inv.classList.remove('hidden');
    // "#try?r=…" doesn't match the section id, so scroll there manually.
    requestAnimationFrame(() => $('try').scrollIntoView({ block: 'start' }));
  }

  // Test hook (no secrets, no network): lets smoke tests render the card deterministically.
  window.__atlasTest = { drawCard: r => drawCard(C.normalizeReport(r)).toDataURL('image/png') };
})();
