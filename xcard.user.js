// ==UserScript==
// @name         XCard - X Post to Chinese Card PNG
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Add a PNG button on X posts; auto-translate to Chinese, render a white card with neon-highlight text and download as image.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      translate.googleapis.com
// @connect      pbs.twimg.com
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Styles ----------
  GM_addStyle(`
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@500;700;900&display=swap');

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
      padding: 24px;
      overflow:auto;
    }

    .tm-xpng-stage{
      position:relative;
      width:1080px;
      padding:70px;
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

    .tm-xpng-quote{ margin-top:24px; padding:20px 24px; border:2px solid #e1e8ed; border-radius:16px; background:#f7f9fa; }
    .tm-xpng-quote-head{ display:flex; align-items:center; gap:10px; }
    .tm-xpng-quote-avatar{ width:36px; height:36px; border-radius:50%; overflow:hidden; }
    .tm-xpng-quote-avatar img{ width:100%; height:100%; object-fit:cover; display:block; }
    .tm-xpng-quote-name{ font-weight:800; font-size:22px; }
    .tm-xpng-quote-handle{ font-size:20px; opacity:.6; font-weight:700; }
    .tm-xpng-quote-body{ margin-top:10px; font-size:28px; line-height:1.5; font-weight:800; }

    .tm-xpng-stats{
      margin-top:28px;
      display:flex;
      gap:36px;
      font-size:26px;
      font-weight:700;
      color:#536471;
    }
    .tm-xpng-stat-val{ color:#000; margin-right:4px; }

    .tm-xpng-watermark{
      position:absolute;
      bottom:24px;
      right:32px;
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

    .tm-xpng-loading{
      position:fixed; inset:0; background:rgba(0,0,0,.4);
      display:flex; align-items:center; justify-content:center;
      z-index:9999999;
      color:#fff; font-size:20px; font-weight:700;
      font-family: 'Noto Sans TC', system-ui, sans-serif;
    }
  `);

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
    const textEl = q(article, 'div[data-testid="tweetText"]');
    const text = safeText(textEl);

    const userName = q(article, 'div[data-testid="User-Name"]');
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
    const quoteTweetEl = q(article, 'div[data-testid="quoteTweet"]');
    const allPhotoImgs = qa(article, '[data-testid="tweetPhoto"] img');
    const images = allPhotoImgs
      .filter(img => !quoteTweetEl || !quoteTweetEl.contains(img))
      .map(img => ({ src: img.src }))
      .filter(img => img.src);

    // Quoted tweet
    let quotedTweet = null;
    if (quoteTweetEl) {
      const qtTextEl = q(quoteTweetEl, 'div[data-testid="tweetText"]');
      const qtUserName = q(quoteTweetEl, 'div[data-testid="User-Name"]');
      let qtDisplayName = '';
      let qtHandle = '';
      if (qtUserName) {
        const qtSpans = qa(qtUserName, 'span').map(s => safeText(s)).filter(Boolean);
        qtDisplayName = qtSpans.find(t => !t.startsWith('@')) || qtSpans[0] || '';
        qtHandle = normalizeHandle(qtSpans.find(t => t.startsWith('@')) || '');
      }
      const qtAvatarImg = q(quoteTweetEl, 'img[src*="profile_images"]');
      quotedTweet = {
        displayName: qtDisplayName,
        handle: qtHandle,
        text: safeText(qtTextEl),
        avatarUrl: qtAvatarImg?.src || '',
      };
    }

    return { displayName, handle, timeText, datetime, text, avatarUrl, tweetUrl, replies, retweets, likes, views, images, quotedTweet };
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

    // Build quoted tweet HTML
    let quoteHtml = '';
    if (data.quotedTweet) {
      const qt = data.quotedTweet;
      const qtText = (qt.cnText || qt.text || '').trim();
      const qtBodyHtml = escapeHtml(qtText)
        .split('\n')
        .map(line => {
          const trimmed = line.trim();
          if (!trimmed) return '';
          return `<span class="tm-hl">${line}</span>`;
        })
        .filter(Boolean)
        .join('<br>');
      const qtAvatarSrc = qt.avatarDataUrl || qt.avatarUrl || '';
      quoteHtml = `
        <div class="tm-xpng-quote">
          <div class="tm-xpng-quote-head">
            ${qtAvatarSrc ? `<div class="tm-xpng-quote-avatar"><img src="${escapeHtml(qtAvatarSrc)}"></div>` : ''}
            <div class="tm-xpng-quote-name">${escapeHtml(qt.displayName || '')}</div>
            <div class="tm-xpng-quote-handle">${escapeHtml(qt.handle || '')}</div>
          </div>
          <div class="tm-xpng-quote-body">${qtBodyHtml}</div>
        </div>`;
    }

    const avatarSrc = data.avatarDataUrl || data.avatarUrl || '';

    stage.innerHTML = `
      <div class="tm-xpng-row">
        <div class="tm-xpng-avatar">${avatarSrc ? `<img src="${escapeHtml(avatarSrc)}">` : ''}</div>
        <div style="flex:1; min-width:0;">
          <div class="tm-xpng-head">
            <div class="tm-xpng-name">${escapeHtml(data.displayName || 'Unknown')}</div>
            <div class="tm-xpng-handle">${escapeHtml(data.handle || '')}</div>
            <div class="tm-xpng-time">· ${escapeHtml(data.timeText || '')}</div>
          </div>

          <div class="tm-xpng-body">
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
      <div class="tm-xpng-watermark">XCard</div>
    `;
    return stage;
  }

  // ---------- Highlight rects for html2canvas ----------
  // html2canvas can't render linear-gradient + box-decoration-break on wrapped
  // inline spans. Fix: compute each line fragment with getClientRects(), create
  // absolutely positioned divs with solid yellow background, hide CSS highlight.
  function applyHighlightRects(stage) {
    // Process all containers that hold .tm-hl spans (main body + quoted tweet body)
    const containers = Array.from(stage.querySelectorAll('.tm-xpng-body, .tm-xpng-quote-body'));
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
  async function renderAndDownload(stage, filenameBase = 'xcard') {
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

    // Replace CSS highlights with positioned divs for html2canvas compatibility
    const cleanupHL = applyHighlightRects(stage);

    const canvas = await window.html2canvas(stage, {
      backgroundColor: null,
      scale: 2,
      useCORS: true,
      allowTaint: true,
      logging: false,
    });

    // Restore CSS highlights
    cleanupHL();

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${filenameBase}-${ts}.png`;

    if (typeof GM_download === 'function') {
      const url = URL.createObjectURL(blob);
      GM_download({ url, name: filename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } else {
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = filename;
      a.click();
    }
  }

  // ---------- Preview ----------
  async function openPreview(article) {
    const data = extractTweetData(article);
    if (!data.text) {
      alert('抓不到貼文內容（tweetText selector 失效）。');
      return;
    }

    // Translate + preload images as base64 (bypasses CORS for html2canvas)
    const hideLoading = showLoading('翻譯中...');
    try {
      const imageUrls = data.images.map(img => img.src);
      if (data.quotedTweet?.avatarUrl) imageUrls.push(data.quotedTweet.avatarUrl);
      if (data.avatarUrl) imageUrls.push(data.avatarUrl);

      const results = await Promise.all([
        translateText(data.text, 'zh-TW'),
        data.quotedTweet ? translateText(data.quotedTweet.text, 'zh-TW') : Promise.resolve(null),
        ...imageUrls.map(url => fetchImageAsDataUrl(url)),
      ]);

      data.cnText = results[0];
      if (data.quotedTweet) {
        data.quotedTweet.cnText = results[1];
      }

      // Map base64 data URLs back
      let idx = 2;
      for (const img of data.images) {
        img.dataUrl = results[idx++] || img.src;
      }
      if (data.quotedTweet?.avatarUrl) {
        data.quotedTweet.avatarDataUrl = results[idx++] || '';
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
    wrapper.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:0;';

    const stage = buildStageHTML(data);
    wrapper.appendChild(stage);

    // Action buttons — outside stage, won't appear in PNG
    const actions = document.createElement('div');
    actions.className = 'tm-xpng-actions';
    actions.innerHTML = `
      <div class="tm-xpng-action" data-act="close">Close</div>
      <div class="tm-xpng-action" data-act="download">Download PNG</div>
    `;
    wrapper.appendChild(actions);

    overlay.appendChild(wrapper);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', async (e) => {
      const act = e.target?.getAttribute?.('data-act');
      if (act === 'close') {
        overlay.remove();
        return;
      }
      if (act === 'download') {
        const base = (data.handle || 'xcard').replace('@', '') || 'xcard';
        await renderAndDownload(stage, base);
        overlay.remove();
        return;
      }
      if (e.target === overlay) overlay.remove();
    });
  }

  // ---------- Inject buttons ----------
  function injectButtons() {
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

  // Dynamic page support
  const mo = new MutationObserver(() => injectButtons());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  (async () => {
    await sleep(800);
    injectButtons();
  })();

})();
