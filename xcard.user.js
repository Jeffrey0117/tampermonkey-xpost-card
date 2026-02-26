// ==UserScript==
// @name         XCard - X/Threads Post to Chinese Card PNG
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Add a PNG button on X/Threads posts; auto-translate to Chinese, render a white card with neon-highlight text and download as image.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://www.threads.com/*
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      translate.googleapis.com
// @connect      pbs.twimg.com
// @connect      fbcdn.net
// @connect      cdninstagram.com
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @require      https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js
// ==/UserScript==

(function () {
  'use strict';

  const IS_THREADS = location.hostname.includes('threads.com') || location.hostname.includes('threads.net');

  // ---------- Trusted Types policy (required by Threads CSP) ----------
  let ttPolicy;
  if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {
    try {
      ttPolicy = trustedTypes.createPolicy('default', { createHTML: (s) => s });
    } catch (_) {
      try { ttPolicy = trustedTypes.createPolicy('xcard', { createHTML: (s) => s }); }
      catch (_2) { /* ignore */ }
    }
  }
  function safeInnerHTML(el, html) {
    el.innerHTML = ttPolicy ? ttPolicy.createHTML(html) : html;
  }

  // ---------- Pure Canvas renderer (Threads fallback, zero CSP issues) ----------
  function loadImg(src) {
    if (!src) return Promise.resolve(null);
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function wrapText(ctx, text, maxW) {
    const lines = [];
    for (const paragraph of text.split('\n')) {
      if (!paragraph.trim()) { lines.push(''); continue; }
      const words = paragraph.split('');
      let line = '';
      for (const ch of words) {
        const test = line + ch;
        if (ctx.measureText(test).width > maxW && line) {
          lines.push(line);
          line = ch;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  async function renderCardCanvas(data, fontFamily, scale = 2) {
    const W = 1200, PAD = 80, AVATAR = 92, GAP = 22;
    const contentW = W - PAD * 2 - AVATAR - GAP;
    const bodyFontSize = 38, bodyLH = 1.55;
    const lineH = bodyFontSize * bodyLH;

    // Pre-measure body text to compute card height
    const measureCanvas = document.createElement('canvas');
    const mCtx = measureCanvas.getContext('2d');
    mCtx.font = `900 ${bodyFontSize}px ${fontFamily}`;
    const bodyText = (data.cnText || data.text || '').trim().replace(/\n{3,}/g, '\n\n');
    const bodyLines = wrapText(mCtx, bodyText, contentW);

    // Compute total height
    let y = PAD; // top padding
    const headerH = 40;
    y += headerH + 18; // header + gap
    y += bodyLines.length * lineH; // body
    const images = (data.images || []).filter(img => img.dataUrl || img.src);
    if (images.length > 0) { y += 24 + 300; } // media
    if (data.replies || data.retweets || data.likes) { y += 28 + 30; } // stats
    y += PAD; // bottom padding
    const H = Math.max(y, 300);

    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    // White background with rounded corners
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 28);
    ctx.fill();

    // QR code (top right)
    const qrUrl = data.tweetUrl ? generateQrDataUrl(data.tweetUrl) : '';
    if (qrUrl) {
      const qrImg = await loadImg(qrUrl);
      if (qrImg) { ctx.globalAlpha = 0.7; ctx.drawImage(qrImg, W - 34 - 56, 30, 56, 56); ctx.globalAlpha = 1; }
    }

    // Avatar (circle clip)
    const avatarSrc = data.avatarDataUrl || data.avatarUrl || '';
    const avatarImg = await loadImg(avatarSrc);
    const avX = PAD, avY = PAD;
    if (avatarImg) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(avX + AVATAR / 2, avY + AVATAR / 2, AVATAR / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(avatarImg, avX, avY, AVATAR, AVATAR);
      ctx.restore();
    } else {
      ctx.fillStyle = '#eee';
      ctx.beginPath();
      ctx.arc(avX + AVATAR / 2, avY + AVATAR / 2, AVATAR / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Header: name, handle, time
    let hx = PAD + AVATAR + GAP;
    ctx.fillStyle = '#000';
    ctx.font = `900 34px ${fontFamily}`;
    ctx.fillText(data.displayName || '', hx, PAD + 32);
    hx += ctx.measureText(data.displayName || '').width + 12;
    ctx.font = `700 26px ${fontFamily}`;
    ctx.globalAlpha = 0.7;
    ctx.fillText(data.handle || '', hx, PAD + 30);
    hx += ctx.measureText(data.handle || '').width + 12;
    ctx.globalAlpha = 0.6;
    ctx.font = `700 24px ${fontFamily}`;
    ctx.fillText('· ' + (data.timeText || ''), hx, PAD + 29);
    ctx.globalAlpha = 1;

    // Body text with yellow highlight
    const bx = PAD + AVATAR + GAP;
    let by = PAD + headerH + 18;
    ctx.font = `900 ${bodyFontSize}px ${fontFamily}`;
    for (const line of bodyLines) {
      if (line.trim()) {
        const tw = ctx.measureText(line).width;
        const hlY = by + lineH * 0.58 - bodyFontSize * 0.15;
        const hlH = lineH * 0.42;
        ctx.fillStyle = 'rgba(255, 242, 0, 0.95)';
        ctx.fillRect(bx - 3, hlY, tw + 6, hlH);
      }
      ctx.fillStyle = '#000';
      ctx.fillText(line, bx, by + bodyFontSize);
      by += lineH;
    }

    // Media images
    if (images.length > 0) {
      by += 24;
      const imgW = images.length === 1 ? contentW : (contentW - 8) / 2;
      const imgH = 300;
      for (let i = 0; i < Math.min(images.length, 4); i++) {
        const mImg = await loadImg(images[i].dataUrl || images[i].src);
        if (!mImg) continue;
        const ix = bx + (i % 2) * (imgW + 8);
        const iy = by + Math.floor(i / 2) * (imgH + 8);
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(ix, iy, imgW, imgH, 16);
        ctx.clip();
        // Cover fit
        const ar = mImg.width / mImg.height;
        const tar = imgW / imgH;
        let sw, sh, sx, sy;
        if (ar > tar) { sh = mImg.height; sw = sh * tar; sx = (mImg.width - sw) / 2; sy = 0; }
        else { sw = mImg.width; sh = sw / tar; sx = 0; sy = (mImg.height - sh) / 2; }
        ctx.drawImage(mImg, sx, sy, sw, sh, ix, iy, imgW, imgH);
        ctx.restore();
      }
      by += imgH + (images.length > 2 ? imgH + 8 : 0);
    }

    // Stats
    if (data.replies || data.retweets || data.likes) {
      by += 28;
      ctx.font = `700 26px ${fontFamily}`;
      let sx = bx;
      for (const [val, label] of [[data.replies, 'Replies'], [data.retweets, 'Reposts'], [data.likes, 'Likes']]) {
        if (!val) continue;
        ctx.fillStyle = '#000';
        ctx.fillText(val, sx, by + 22);
        sx += ctx.measureText(val).width + 4;
        ctx.fillStyle = '#536471';
        ctx.fillText(label, sx, by + 22);
        sx += ctx.measureText(label).width + 36;
      }
    }

    // Watermark
    ctx.font = `700 18px ${fontFamily}`;
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#000';
    ctx.fillText(IS_THREADS ? 'ThreadCard' : 'XCard', 32, H - 24);
    ctx.globalAlpha = 1;

    return canvas;
  }

  // ---------- Load Google Fonts via <link> (avoids CSP style-src block on Threads) ----------
  const _fontLink = document.createElement('link');
  _fontLink.rel = 'stylesheet';
  _fontLink.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@500;700;900&family=Noto+Serif+TC:wght@500;700;900&family=LXGW+WenKai+TC:wght@400;700&display=swap';
  (document.head || document.documentElement).appendChild(_fontLink);

  // ---------- Styles ----------
  // Use textContent instead of GM_addStyle to avoid TrustedHTML violations
  const _style = document.createElement('style');
  _style.textContent = `

    .tm-xpng-btn{
      cursor:pointer;
      user-select:none;
      font-size:12px;
      padding:4px 8px;
      border-radius:999px;
      border:1px solid rgba(0,0,0,.15);
      background:rgba(255,255,255,.9);
      color:#111;
      margin-left:8px;
    }
    .tm-xpng-btn:hover{ background:#fff; }

    .tm-xpng-overlay{
      position:fixed; inset:0; background:rgba(0,0,0,.55);
      display:flex; align-items:center; justify-content:center;
      z-index:999999;
      padding: 16px;
      overflow:auto;
    }
    .tm-xpng-preview-wrap{
      display:flex; flex-direction:column; align-items:center; gap:6px;
    }

    .tm-xpng-stage{
      position:relative;
      width:1200px;
      padding:80px;
      background:#ffffff;
      font-family: 'Noto Sans TC', ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      color:#000;
      border-radius:28px;
      box-shadow: 0 20px 80px rgba(0,0,0,.35);
    }

    .tm-xpng-row{ display:flex; gap:22px; }

    .tm-xpng-avatar{
      width:92px; height:92px; border-radius:999px;
      background:#eee; flex:0 0 auto; overflow:hidden;
    }
    .tm-xpng-avatar img{ width:100%; height:100%; object-fit:cover; display:block; }

    .tm-xpng-head{ display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
    .tm-xpng-name{ font-weight:900; font-size:34px; line-height:1.1; }
    .tm-xpng-handle{ font-size:26px; opacity:.70; font-weight:700; }
    .tm-xpng-time{ font-size:24px; opacity:.60; font-weight:700; }

    .tm-xpng-body{
      margin-top:18px;
      font-size:38px;
      line-height:1.55;
      letter-spacing:.2px;
      white-space:normal;
      word-break:break-word;
      font-weight:900;
    }

    .tm-xpng-body[contenteditable="true"]{ cursor:text; }
    .tm-xpng-body[contenteditable="true"]:hover{
      outline:2px dashed rgba(0,0,0,.12); outline-offset:6px; border-radius:8px;
    }
    .tm-xpng-body[contenteditable="true"]:focus{
      outline:2px solid rgba(0,0,0,.25); outline-offset:6px; border-radius:8px;
    }

    /* Each line gets its own highlight span — no bleed on line breaks */
    .tm-hl{
      display:inline;
      padding: 0.06em 0.18em;
      border-radius: 0.18em;
      background: linear-gradient(transparent 58%, rgba(255, 242, 0, 0.95) 58%);
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }

    .tm-xpng-media{ margin-top:24px; display:grid; gap:8px; border-radius:16px; overflow:hidden; }
    .tm-xpng-media.cols-1{ grid-template-columns:1fr; }
    .tm-xpng-media.cols-2{ grid-template-columns:1fr 1fr; }
    .tm-xpng-media img{ width:100%; height:100%; object-fit:cover; display:block; }

    .tm-xpng-quote{ margin-top:24px; border-radius:16px; overflow:hidden; }
    .tm-xpng-quote img{ width:100%; display:block; }

    .tm-xpng-stats{
      margin-top:28px;
      display:flex;
      gap:36px;
      font-size:26px;
      font-weight:700;
      color:#536471;
    }
    .tm-xpng-stat-val{ color:#000; margin-right:4px; }

    .tm-xpng-qr{
      position:absolute;
      top:30px;
      right:34px;
      width:56px;
      height:56px;
      opacity:0.7;
    }
    .tm-xpng-qr img{ width:100%; height:100%; display:block; }

    .tm-xpng-watermark{
      position:absolute;
      bottom:24px;
      left:32px;
      font-size:18px;
      font-weight:700;
      opacity:0.18;
      color:#000;
      pointer-events:none;
      user-select:none;
    }

    .tm-xpng-actions{
      margin-top:16px;
      display:flex; gap:10px; justify-content:center;
    }
    .tm-xpng-action{
      cursor:pointer;
      border:1px solid rgba(255,255,255,.3);
      background:rgba(255,255,255,.15);
      border-radius:999px;
      padding:10px 20px;
      font-size:15px;
      font-weight:700;
      color:#fff;
      backdrop-filter:blur(4px);
    }
    .tm-xpng-action:hover{
      background:rgba(255,255,255,.25);
    }

    .tm-xpng-toolbar{
      display:flex; align-items:center; gap:8px; margin-top:10px;
      font-family:system-ui,sans-serif;
    }
    .tm-xpng-toolbar-label{
      font-size:12px; color:rgba(255,255,255,.45); font-weight:600;
    }
    .tm-xpng-font-btn{
      cursor:pointer; padding:4px 12px; border-radius:999px;
      font-size:13px; font-weight:700; color:rgba(255,255,255,.7);
      border:1px solid rgba(255,255,255,.2); background:transparent;
      transition: all .15s;
    }
    .tm-xpng-font-btn:hover{ background:rgba(255,255,255,.12); color:#fff; }
    .tm-xpng-font-btn.active{
      background:rgba(255,255,255,.2); color:#fff;
      border-color:rgba(255,255,255,.5);
    }

    .tm-xpng-loading{
      position:fixed; inset:0; background:rgba(0,0,0,.4);
      display:flex; align-items:center; justify-content:center;
      z-index:9999999;
      color:#fff; font-size:20px; font-weight:700;
      font-family: 'Noto Sans TC', system-ui, sans-serif;
    }
  `;
  (document.head || document.documentElement).appendChild(_style);

  // ---------- Font options ----------
  const FONTS = [
    { label: '黑體', family: "'Noto Sans TC', sans-serif" },
    { label: '宋體', family: "'Noto Serif TC', serif" },
    { label: '文楷', family: "'LXGW WenKai TC', cursive" },
  ];

  // ---------- QR Code ----------
  function generateQrDataUrl(text) {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createDataURL(4, 0);
    } catch (e) {
      console.error('XCard: QR generation failed:', e);
      return '';
    }
  }

  // ---------- Helpers ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (el, sel) => (el ? el.querySelector(sel) : null);
  const qa = (el, sel) => (el ? Array.from(el.querySelectorAll(sel)) : []);

  function safeText(node) {
    if (!node) return '';
    return (node.innerText || node.textContent || '').trim();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function normalizeHandle(maybe) {
    const s = (maybe || '').trim();
    if (!s) return '';
    if (s.startsWith('@')) return s;
    const at = s.indexOf('@');
    if (at >= 0) return s.slice(at);
    return '';
  }

  // ---------- Google Translate ----------
  function translateChunk(text, targetLang) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`,
        onload(response) {
          try {
            const result = JSON.parse(response.responseText);
            const translated = result[0].map(item => item[0]).join('');
            resolve(translated);
          } catch (e) {
            console.error('XCard translate parse error:', e);
            resolve(text);
          }
        },
        onerror(err) {
          console.error('XCard translate request error:', err);
          resolve(text);
        },
        ontimeout() {
          console.error('XCard translate timeout');
          resolve(text);
        },
        timeout: 10000,
      });
    });
  }

  // Split long text into chunks at sentence boundaries to avoid Google Translate
  // URL length limits (long GET URLs cause partial/broken translations).
  const CHUNK_MAX = 800;
  async function translateText(text, targetLang = 'zh-TW') {
    if (!text || text.length <= CHUNK_MAX) {
      return translateChunk(text, targetLang);
    }
    // Split at sentence-ending punctuation followed by whitespace/newline
    const sentences = text.match(/[^.!?\n]+[.!?\n]+[\s]*/g) || [text];
    const chunks = [];
    let buf = '';
    for (const s of sentences) {
      if (buf.length + s.length > CHUNK_MAX && buf) {
        chunks.push(buf);
        buf = '';
      }
      buf += s;
    }
    if (buf) chunks.push(buf);
    const results = await Promise.all(chunks.map(c => translateChunk(c, targetLang)));
    return results.join('');
  }

  // ---------- Fetch image as base64 (bypasses CORS via GM_xmlhttpRequest) ----------
  function fetchImageAsDataUrl(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        onload(resp) {
          if (!resp.response) return resolve('');
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => resolve('');
          reader.readAsDataURL(resp.response);
        },
        onerror: () => resolve(''),
        ontimeout: () => resolve(''),
        timeout: 8000,
      });
    });
  }

  // ---------- Screenshot a DOM element (for quoted tweets) ----------
  async function screenshotElement(el) {
    if (!el) return '';
    // Swap images to base64 to bypass CORS (loading overlay hides the flash)
    const imgs = Array.from(el.querySelectorAll('img'));
    const origSrcs = imgs.map(img => img.src);
    const b64s = await Promise.all(
      origSrcs.map(src => src ? fetchImageAsDataUrl(src) : Promise.resolve(''))
    );
    imgs.forEach((img, i) => { if (b64s[i]) img.src = b64s[i]; });
    try {
      const canvas = await window.html2canvas(el, {
        backgroundColor: null,
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
      });
      return canvas.toDataURL('image/png');
    } catch (e) {
      console.error('XCard: screenshotElement failed:', e);
      return '';
    } finally {
      imgs.forEach((img, i) => { img.src = origSrcs[i]; });
    }
  }

  // ---------- Loading overlay ----------
  function showLoading(msg = '翻譯中...') {
    const el = document.createElement('div');
    el.className = 'tm-xpng-loading';
    el.textContent = msg;
    document.body.appendChild(el);
    return () => el.remove();
  }

  // ---------- Data extraction ----------
  function extractTweetData(article) {
    // Find quoted tweet container FIRST so we can exclude it from main-tweet selectors
    const quoteTweetEl = q(article, '[data-testid="quoteTweet"]');

    // Main tweet text (skip any tweetText inside quoted tweet)
    const allTextEls = qa(article, 'div[data-testid="tweetText"]');
    const textEl = quoteTweetEl
      ? allTextEls.find(el => !quoteTweetEl.contains(el))
      : allTextEls[0];
    const text = safeText(textEl);

    // Main tweet user info (skip quoted tweet's User-Name)
    const allUserNames = qa(article, 'div[data-testid="User-Name"]');
    const userName = quoteTweetEl
      ? allUserNames.find(el => !quoteTweetEl.contains(el))
      : allUserNames[0];
    let displayName = '';
    let handle = '';

    if (userName) {
      const spans = qa(userName, 'span').map(s => safeText(s)).filter(Boolean);
      displayName = spans.find(t => !t.startsWith('@')) || spans[0] || '';
      handle = spans.find(t => t.startsWith('@')) || '';
      handle = normalizeHandle(handle);
    }

    const timeEl = q(article, 'time');
    const datetime = timeEl?.getAttribute('datetime') || '';
    const timeText = safeText(timeEl) || (datetime ? new Date(datetime).toLocaleString() : '');

    const avatarImg =
      q(article, 'img[src*="profile_images"]') ||
      q(article, 'img[alt][draggable="true"]');
    const avatarUrl = avatarImg?.src || '';

    const linkEl = q(article, 'a[href*="/status/"]');
    const tweetUrl = linkEl ? (location.origin + linkEl.getAttribute('href')) : location.href;

    // Engagement stats
    const actionBar = q(article, 'div[role="group"]');
    function statNum(testId) {
      const el = q(actionBar, `button[data-testid="${testId}"] span[data-testid="${testId}"]`)
        || q(actionBar, `button[data-testid="${testId}"] span`)
        || q(actionBar, `[data-testid="${testId}"]`);
      const raw = safeText(el);
      return raw && raw !== '0' ? raw : '';
    }
    const replies = statNum('reply');
    const retweets = statNum('retweet');
    const likes = statNum('like');

    // Views: usually an <a> linking to analytics
    const viewsEl = q(actionBar, 'a[href*="/analytics"] span')
      || q(actionBar, 'a[aria-label*="view"] span')
      || q(actionBar, 'a[aria-label*="View"] span');
    const views = safeText(viewsEl) || '';

    // Images (exclude images inside quoted tweet)
    const allPhotoImgs = qa(article, '[data-testid="tweetPhoto"] img');
    const images = allPhotoImgs
      .filter(img => !quoteTweetEl || !quoteTweetEl.contains(img))
      .map(img => ({ src: img.src }))
      .filter(img => img.src);

    return { displayName, handle, timeText, datetime, text, avatarUrl, tweetUrl, replies, retweets, likes, views, images, quoteTweetEl };
  }

  // ---------- Threads: find post container ----------
  function findThreadsContainer(postLink) {
    let el = postLink;
    for (let i = 0; i < 20; i++) {
      el = el.parentElement;
      if (!el) return null;
      const hasUserLink = el.querySelector('a[href^="/@"]:not([href*="/post/"])');
      const hasStatButtons = el.querySelectorAll('div[role="button"]').length >= 2;
      if (hasUserLink && hasStatButtons) return el;
    }
    return null;
  }

  // ---------- Threads: find stats bar ----------
  function findThreadsStatsBar(container) {
    const buttons = qa(container, 'div[role="button"]');
    if (buttons.length < 2) return null;

    const parentCounts = new Map();
    for (const btn of buttons) {
      if (!btn.querySelector('svg')) continue;
      let p = btn.parentElement;
      for (let i = 0; i < 3; i++) {
        if (!p) break;
        parentCounts.set(p, (parentCounts.get(p) || 0) + 1);
        p = p.parentElement;
      }
    }

    let best = null;
    let bestCount = 0;
    for (const [el, count] of parentCounts) {
      if (count > bestCount || (count === bestCount && best && best.contains(el))) {
        best = el;
        bestCount = count;
      }
    }
    return best;
  }

  // ---------- Threads: data extraction ----------
  function extractThreadsData(container) {
    const userLinks = qa(container, 'a[href^="/@"]:not([href*="/post/"])');
    let handle = '';
    let displayName = '';
    let avatarUrl = '';

    if (userLinks.length > 0) {
      const href = userLinks[0].getAttribute('href') || '';
      handle = href.startsWith('/') ? href.slice(1) : href;
      if (!handle.startsWith('@')) handle = '@' + handle;
      displayName = safeText(userLinks[0]) || handle.slice(1);

      // Try img inside user links first
      let avatarImg = userLinks.map(link => link.querySelector('img')).find(img => img?.src);
      // Fallback: find small avatar-like img anywhere in container (Threads may place avatar outside link)
      if (!avatarImg) {
        const allImgs = qa(container, 'img');
        avatarImg = allImgs.find(img => {
          if (!img.src || img.src.startsWith('data:')) return false;
          if (img.closest('picture')) return false; // skip post content images
          const w = img.width || img.naturalWidth || 0;
          return w > 0 && w <= 80;
        });
      }
      avatarUrl = avatarImg?.src || '';
    }

    const timeEl = q(container, 'time[datetime]');
    const datetime = timeEl?.getAttribute('datetime') || '';
    const timeTitle = timeEl?.getAttribute('title') || '';
    const timeText = timeTitle || safeText(timeEl) || (datetime ? new Date(datetime).toLocaleString() : '');

    const postLinkEl = q(container, 'a[href*="/post/"]');
    const postHref = postLinkEl?.getAttribute('href') || '';
    const tweetUrl = postHref
      ? (postHref.startsWith('http') ? postHref : location.origin + postHref)
      : location.href;

    let text = '';
    // Broadened: both span AND div with dir="auto" (Threads DOM changes frequently)
    const textEls = qa(container, '[dir="auto"]');
    const textParts = [];
    const seen = new Set();
    // Build a set of elements to exclude (time-related, avatar-adjacent, etc.)
    const timeParentA = timeEl ? timeEl.closest('a') : null;

    // Find reply boundary: the first post link with a DIFFERENT href marks where replies start
    const allPostLinks = qa(container, 'a[href*="/post/"]');
    const replyBoundary = postHref
      ? allPostLinks.find(a => a.getAttribute('href') !== postHref)
      : null;

    for (const el of textEls) {
      // Skip elements that appear AFTER the reply boundary (they belong to replies)
      if (replyBoundary && (el.compareDocumentPosition(replyBoundary) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
      if (el.closest('time')) continue;
      if (el.closest('[role="button"]')) continue;
      // Skip elements that contain a <time> descendant (wrapper around timestamp)
      if (el.querySelector('time')) continue;
      // Skip username links, but ALLOW post-link wrappers that contain the text body
      const closestA = el.closest('a');
      if (closestA && closestA.matches('a[href^="/@"]:not([href*="/post/"])')) continue;
      // Skip elements inside the same <a> as the time element (e.g., "18小時" next to <time>)
      if (timeParentA && closestA === timeParentA) continue;
      // Prefer leaf [dir="auto"] nodes — skip parents that contain child [dir="auto"]
      if (el.querySelector('[dir="auto"]')) continue;

      const clone = el.cloneNode(true);
      clone.querySelectorAll('[role="button"]').forEach(child => child.remove());
      const t = (clone.innerText || clone.textContent || '').trim();
      if (!t || seen.has(t)) continue;
      // Skip relative time strings (e.g., "18小時", "2d", "3天")
      if (/^\d+\s*(秒鐘?|分鐘?|小時|天|日|週|月|年|[smhdwy])$/i.test(t)) continue;
      // Skip UI labels (e.g., "Thread" badge, "Suggested", "Ad")
      if (/^(Thread|串文|字串文|Suggested|推薦|廣告|Sponsored|Ad)$/i.test(t)) continue;
      // Skip interaction/stat text with optional multiplier (e.g., "7.3萬次瀏覽", "148 則回覆", "27 likes")
      if (/^(查看|view|顯示)?\s*[\d,.]+\s*(萬|千|億|[KkMmBb])?\s*(次瀏覽|次觀看|則回覆|個回覆|回覆|則留言|個留言|留言|個讚|讚|次轉發|次分享|replies?|likes?|reposts?|shares?|views?|comments?)$/i.test(t)) continue;
      seen.add(t);
      textParts.push(t);
    }
    text = textParts.join('\n');

    const imageEls = qa(container, 'picture img[draggable="false"]');
    const images = imageEls.map(img => ({ src: img.src })).filter(img => img.src);

    let likes = '';
    let replies = '';
    let retweets = '';
    const statButtons = qa(container, 'div[role="button"]');
    for (const btn of statButtons) {
      const svgTitle = q(btn, 'svg title');
      if (!svgTitle) continue;
      const titleText = safeText(svgTitle).toLowerCase();
      const countSpan = btn.querySelector('span');
      const count = countSpan ? safeText(countSpan) : '';
      if (titleText.includes('like') || titleText.includes('讚')) {
        likes = count;
      } else if (titleText.includes('reply') || titleText.includes('回覆')) {
        replies = count;
      } else if (titleText.includes('repost') || titleText.includes('轉發')) {
        retweets = count;
      }
    }

    return { displayName, handle, timeText, datetime, text, avatarUrl, tweetUrl, replies, retweets, likes, views: '', images, quoteTweetEl: null };
  }

  // ---------- Build card HTML ----------
  function buildStageHTML(data) {
    const stage = document.createElement('div');
    stage.className = 'tm-xpng-stage';

    const rawText = (data.cnText || data.text || '').trim();

    // Collapse consecutive blank lines into a single paragraph break
    const normalizedText = rawText.replace(/\n{3,}/g, '\n\n');

    // Split by newlines, wrap each non-empty line in its own .tm-hl span
    const bodyHtml = escapeHtml(normalizedText)
      .split('\n')
      .map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        return `<span class="tm-hl">${line}</span>`;
      })
      .filter(Boolean)
      .join('<br>');

    // Build media grid HTML
    const images = data.images || [];
    let mediaHtml = '';
    if (images.length > 0) {
      const colsClass = images.length === 1 ? 'cols-1' : 'cols-2';
      const imgsHtml = images.map(img => {
        const src = escapeHtml(img.dataUrl || img.src);
        return `<img src="${src}">`;
      }).join('');
      mediaHtml = `<div class="tm-xpng-media ${colsClass}">${imgsHtml}</div>`;
    }

    // Quoted tweet as screenshot image
    let quoteHtml = '';
    if (data.quoteTweetImage) {
      quoteHtml = `<div class="tm-xpng-quote"><img src="${escapeHtml(data.quoteTweetImage)}"></div>`;
    }

    const avatarSrc = data.avatarDataUrl || data.avatarUrl || '';
    const qrDataUrl = data.tweetUrl ? generateQrDataUrl(data.tweetUrl) : '';

    safeInnerHTML(stage, `
      ${qrDataUrl ? `<div class="tm-xpng-qr"><img src="${qrDataUrl}"></div>` : ''}
      <div class="tm-xpng-row">
        <div class="tm-xpng-avatar">${avatarSrc ? `<img src="${escapeHtml(avatarSrc)}">` : ''}</div>
        <div style="flex:1; min-width:0;">
          <div class="tm-xpng-head">
            <div class="tm-xpng-name">${escapeHtml(data.displayName || 'Unknown')}</div>
            <div class="tm-xpng-handle">${escapeHtml(data.handle || '')}</div>
            <div class="tm-xpng-time">· ${escapeHtml(data.timeText || '')}</div>
          </div>

          <div class="tm-xpng-body" contenteditable="true" spellcheck="false">
            ${bodyHtml}
          </div>

          ${mediaHtml}

          ${quoteHtml}

          ${(data.replies || data.retweets || data.likes || data.views) ? `
          <div class="tm-xpng-stats">
            ${data.replies ? `<span><span class="tm-xpng-stat-val">${escapeHtml(data.replies)}</span>Replies</span>` : ''}
            ${data.retweets ? `<span><span class="tm-xpng-stat-val">${escapeHtml(data.retweets)}</span>Reposts</span>` : ''}
            ${data.likes ? `<span><span class="tm-xpng-stat-val">${escapeHtml(data.likes)}</span>Likes</span>` : ''}
            ${data.views ? `<span><span class="tm-xpng-stat-val">${escapeHtml(data.views)}</span>Views</span>` : ''}
          </div>` : ''}
        </div>
      </div>
      <div class="tm-xpng-watermark">${IS_THREADS ? 'ThreadCard' : 'XCard'}</div>
    `);
    return stage;
  }

  // ---------- Highlight rects for html2canvas ----------
  // html2canvas can't render linear-gradient + box-decoration-break on wrapped
  // inline spans. Fix: compute each line fragment with getClientRects(), create
  // absolutely positioned divs with solid yellow background, hide CSS highlight.
  function applyHighlightRects(stage) {
    const containers = Array.from(stage.querySelectorAll('.tm-xpng-body'));
    if (containers.length === 0) return () => {};

    const prevPositions = [];
    const created = [];
    const allHlSpans = [];

    for (const body of containers) {
      prevPositions.push(body.style.position);
      body.style.position = 'relative';
      const bodyRect = body.getBoundingClientRect();
      const hlSpans = Array.from(body.querySelectorAll('.tm-hl'));

      for (const span of hlSpans) {
        if (!span.textContent.trim()) continue; // skip empty spans (blank lines)
        allHlSpans.push(span);
        const rects = span.getClientRects();
        for (const r of rects) {
          const top = r.top - bodyRect.top;
          const left = r.left - bodyRect.left;
          // Bottom 42% highlight (matching the gradient: transparent 58%, yellow 58%)
          const hlTop = top + r.height * 0.58;
          const hlHeight = r.height * 0.42;

          const div = document.createElement('div');
          div.style.cssText = `
            position:absolute;
            left:${left - 3}px;
            top:${hlTop}px;
            width:${r.width + 6}px;
            height:${hlHeight}px;
            background:rgba(255,242,0,0.95);
            border-radius:2px;
            pointer-events:none;
          `;
          body.appendChild(div);
          created.push(div);
        }
        // Hide CSS background, raise text above the yellow divs
        span.style.background = 'none';
        span.style.position = 'relative';
        span.style.zIndex = '1';
      }
    }

    // Cleanup function — restore after capture
    return () => {
      created.forEach(el => el.remove());
      allHlSpans.forEach(span => {
        span.style.background = '';
        span.style.position = '';
        span.style.zIndex = '';
      });
      containers.forEach((body, i) => {
        body.style.position = prevPositions[i];
      });
    };
  }

  // ---------- Render & Download ----------
  async function renderAndDownload(stage, filenameBase = 'xcard', data, fontFamily) {
    let canvas;

    if (IS_THREADS && data) {
      // Threads: pure Canvas 2D renderer (bypasses Trusted Types CSP entirely)
      // Read edited text from the live stage before rendering
      const bodyEl = stage.querySelector('.tm-xpng-body');
      if (bodyEl) data.cnText = bodyEl.innerText || bodyEl.textContent || data.cnText;
      const font = fontFamily || FONTS[0].family;
      try {
        canvas = await renderCardCanvas(data, font, 2);
      } catch (err) {
        alert('Canvas render error: ' + (err?.message || err));
        return;
      }
    } else {
      // X/Twitter: html2canvas
      const imgs = Array.from(stage.querySelectorAll('img'));
      await Promise.all(imgs.map(img => new Promise(res => {
        if (img.complete) return res();
        const t = setTimeout(res, 5000);
        img.onload = () => { clearTimeout(t); res(); };
        img.onerror = () => { clearTimeout(t); res(); };
      })));

      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, sleep(3000)]);
      }

      const prevZoom = stage.style.zoom;
      stage.style.zoom = '1';
      const editableEls = Array.from(stage.querySelectorAll('[contenteditable="true"]'));
      editableEls.forEach(el => { el.blur(); el.setAttribute('contenteditable', 'false'); });
      const cleanupHL = applyHighlightRects(stage);

      try {
        canvas = await window.html2canvas(stage, {
          backgroundColor: null, scale: 2, useCORS: true, allowTaint: true, logging: false,
        });
      } catch (err) {
        alert('html2canvas error: ' + (err?.message || err));
        cleanupHL();
        stage.style.zoom = prevZoom;
        editableEls.forEach(el => el.setAttribute('contenteditable', 'true'));
        return;
      }

      cleanupHL();
      stage.style.zoom = prevZoom;
      editableEls.forEach(el => el.setAttribute('contenteditable', 'true'));
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${filenameBase}-${ts}.png`;

    if (typeof GM_download === 'function') {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const url = URL.createObjectURL(blob);
      GM_download({ url, name: filename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } else {
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    }
  }

  // ---------- Preview ----------
  async function openPreview(article) {
    const data = IS_THREADS ? extractThreadsData(article) : extractTweetData(article);
    if (!data.text) {
      alert(IS_THREADS
        ? '抓不到貼文內容（Threads DOM selector 可能已變更）。'
        : '抓不到貼文內容（tweetText selector 失效）。');
      return;
    }

    // Translate main text + screenshot quoted tweet + preload images — all in parallel
    const hideLoading = showLoading('翻譯中...');
    try {
      const imageUrls = data.images.map(img => img.src);
      if (data.avatarUrl) imageUrls.push(data.avatarUrl);

      const results = await Promise.all([
        translateText(data.text, 'zh-TW'),
        data.quoteTweetEl ? screenshotElement(data.quoteTweetEl) : Promise.resolve(''),
        ...imageUrls.map(url => fetchImageAsDataUrl(url)),
      ]);

      data.cnText = results[0];
      data.quoteTweetImage = results[1];

      // Map base64 data URLs back
      let idx = 2;
      for (const img of data.images) {
        img.dataUrl = results[idx++] || img.src;
      }
      if (data.avatarUrl) {
        data.avatarDataUrl = results[idx++] || '';
      }
    } catch (e) {
      console.error('XCard translation/image preload failed:', e);
      data.cnText = data.cnText || data.text;
    } finally {
      hideLoading();
    }

    const overlay = document.createElement('div');
    overlay.className = 'tm-xpng-overlay';

    const wrapper = document.createElement('div');
    wrapper.className = 'tm-xpng-preview-wrap';

    const stage = buildStageHTML(data);
    wrapper.appendChild(stage);

    // Auto-clean empty highlight spans when user edits (prevents yellow on blank lines)
    const bodyEl = stage.querySelector('.tm-xpng-body');
    if (bodyEl) {
      bodyEl.addEventListener('input', () => {
        bodyEl.querySelectorAll('.tm-hl').forEach(span => {
          if (!span.textContent.trim()) span.classList.remove('tm-hl');
        });
      });
    }

    // Toolbar — outside stage, won't appear in PNG
    const toolbar = document.createElement('div');
    toolbar.className = 'tm-xpng-toolbar';
    const hintSpan = document.createElement('span');
    hintSpan.className = 'tm-xpng-toolbar-label';
    hintSpan.textContent = '點擊文字可編輯 ·';
    toolbar.appendChild(hintSpan);

    FONTS.forEach((f, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tm-xpng-font-btn' + (i === 0 ? ' active' : '');
      btn.textContent = f.label;
      btn.style.fontFamily = f.family;
      btn.addEventListener('click', () => {
        stage.style.fontFamily = f.family;
        toolbar.querySelectorAll('.tm-xpng-font-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      toolbar.appendChild(btn);
    });
    wrapper.appendChild(toolbar);

    const actions = document.createElement('div');
    actions.className = 'tm-xpng-actions';
    safeInnerHTML(actions, `
      <div class="tm-xpng-action" data-act="close">Close</div>
      <div class="tm-xpng-action" data-act="download">Download PNG</div>
    `);
    wrapper.appendChild(actions);

    overlay.appendChild(wrapper);
    document.body.appendChild(overlay);

    // Stage is now in DOM — measure actual size and zoom to fit viewport
    const sw = stage.offsetWidth;
    const sh = stage.offsetHeight;
    const maxW = window.innerWidth - 40;
    const maxH = window.innerHeight - 100; // reserve for toolbar + buttons
    const zoom = Math.min(maxW / sw, maxH / sh, 0.5);
    stage.style.zoom = String(zoom);

    overlay.addEventListener('click', async (e) => {
      const act = e.target?.getAttribute?.('data-act');
      if (act === 'close') {
        overlay.remove();
        return;
      }
      if (act === 'download') {
        const base = (data.handle || 'xcard').replace('@', '') || 'xcard';
        const font = stage.style.fontFamily || FONTS[0].family;
        await renderAndDownload(stage, base, data, font);
        overlay.remove();
        return;
      }
      if (e.target === overlay) overlay.remove();
    });
  }

  // ---------- Inject buttons ----------
  function injectXButtons() {
    const articles = document.querySelectorAll('article');
    for (const article of articles) {
      const actionBar = article.querySelector('div[role="group"]');
      if (!actionBar) continue;
      if (actionBar.querySelector('.tm-xpng-btn')) continue;

      const btn = document.createElement('button');
      btn.className = 'tm-xpng-btn';
      btn.type = 'button';
      btn.textContent = 'PNG';

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openPreview(article);
      });

      actionBar.appendChild(btn);
    }
  }

  function injectThreadsButtons() {
    const postLinks = document.querySelectorAll('a[href*="/post/"]');
    for (const link of postLinks) {
      const container = findThreadsContainer(link);
      if (!container) continue;
      if (container.querySelector('.tm-xpng-btn')) continue;

      const statsBar = findThreadsStatsBar(container);
      if (!statsBar) continue;
      if (statsBar.querySelector('.tm-xpng-btn')) continue;

      const btn = document.createElement('button');
      btn.className = 'tm-xpng-btn';
      btn.type = 'button';
      btn.textContent = 'PNG';

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openPreview(container);
      });

      statsBar.appendChild(btn);
    }
  }

  function injectButtons() {
    if (IS_THREADS) {
      injectThreadsButtons();
    } else {
      injectXButtons();
    }
  }

  // Dynamic page support
  const mo = new MutationObserver(() => injectButtons());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  (async () => {
    await sleep(800);
    injectButtons();
  })();

})();
