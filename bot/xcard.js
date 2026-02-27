/**
 * XCard — Tweet to Card PNG
 *
 * Takes a tweet URL, fetches data via FxTwitter API,
 * translates to Traditional Chinese, renders a card PNG via Puppeteer.
 */

const puppeteer = require('puppeteer');
const qrcode = require('qrcode-generator');

const FETCH_TIMEOUT = 10_000;
const ALLOWED_HOSTS = ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com', 'mobile.twitter.com', 'mobile.x.com'];

// ==================== Browser Pool ====================

let browser = null;
let browserLaunchPromise = null;

async function ensureBrowser() {
  if (browser && browser.connected) return;
  browser = null;
  if (browserLaunchPromise) {
    await browserLaunchPromise;
    return;
  }
  browserLaunchPromise = puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    browser = await browserLaunchPromise;
    console.log('[XCard] Browser launched');
  } finally {
    browserLaunchPromise = null;
  }
}

async function closeBrowser() {
  if (!browser) return;
  const ref = browser;
  browser = null;
  try {
    await ref.close();
    console.log('[XCard] Browser closed');
  } catch {
    // Browser may have already exited
  }
}

// ==================== Fetch with timeout ====================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ==================== URL Validation ====================

function validateTweetUrl(url) {
  if (typeof url !== 'string') {
    throw new Error('Tweet URL must be a string');
  }
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new Error('Invalid tweet URL host');
  }
  if (!parsed.pathname.match(/\/\w+\/status\/\d+/)) {
    throw new Error('URL does not match tweet pattern');
  }
}

// ==================== FxTwitter API ====================

function parseTweetId(url) {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

async function fetchTweet(tweetUrl) {
  validateTweetUrl(tweetUrl);

  const statusId = parseTweetId(tweetUrl);
  if (!statusId) {
    throw new Error('Could not parse tweet ID from URL');
  }

  const userMatch = tweetUrl.match(/(?:x\.com|twitter\.com)\/(\w+)\/status/);
  const screenName = userMatch ? userMatch[1] : 'i';

  const apiUrl = `https://api.fxtwitter.com/${screenName}/status/${statusId}`;
  const res = await fetchWithTimeout(apiUrl);

  if (!res.ok) {
    throw new Error(`FxTwitter API error: ${res.status}`);
  }

  const json = await res.json();
  const tweet = json.tweet;

  if (!tweet) {
    throw new Error('FxTwitter returned no tweet data');
  }

  return {
    text: tweet.text || '',
    displayName: tweet.author?.name || '',
    handle: `@${tweet.author?.screen_name || ''}`,
    avatarUrl: tweet.author?.avatar_url || '',
    tweetUrl: tweet.url || tweetUrl,
    createdAt: tweet.created_at || '',
    timeText: tweet.created_at
      ? new Date(tweet.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
      : '',
    likes: formatCount(tweet.likes),
    retweets: formatCount(tweet.retweets),
    replies: formatCount(tweet.replies),
    views: formatCount(tweet.views),
    images: extractImages(tweet),
    quoteTweet: tweet.quote ? {
      text: tweet.quote.text || '',
      displayName: tweet.quote.author?.name || '',
      handle: `@${tweet.quote.author?.screen_name || ''}`,
      avatarUrl: tweet.quote.author?.avatar_url || '',
    } : null,
  };
}

function extractImages(tweet) {
  if (!tweet.media?.photos) return [];
  return tweet.media.photos.map(p => ({ src: p.url }));
}

function formatCount(n) {
  if (!n || n === 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ==================== Google Translate ====================

const CHUNK_MAX = 800;

async function translateChunk(text, targetLang) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw new Error(`Google Translate HTTP ${res.status}`);
    }
    const result = await res.json();
    if (!Array.isArray(result) || !Array.isArray(result[0])) {
      throw new Error('Unexpected translate response structure');
    }
    return result[0].map(item => item[0]).join('');
  } catch (e) {
    console.error('[XCard] Translate error:', e.message);
    return text;
  }
}

async function translateText(text, targetLang = 'zh-TW') {
  if (!text) return '';
  if (text.length <= CHUNK_MAX) {
    return translateChunk(text, targetLang);
  }

  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？\n]+[\s]*/g) || [text];
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

// ==================== QR Code ====================

function generateQrDataUrl(text) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(4, 0);
  } catch {
    return '';
  }
}

// ==================== HTML Builder ====================

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function buildCardHtml(data) {
  const rawText = (data.cnText || data.text || '').trim();
  const normalizedText = rawText.replace(/\n{3,}/g, '\n\n');

  const bodyHtml = escapeHtml(normalizedText)
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      return `<span class="tm-hl">${line}</span>`;
    })
    .filter(Boolean)
    .join('<br>');

  const images = data.images || [];
  let mediaHtml = '';
  if (images.length > 0) {
    const colsClass = images.length === 1 ? 'cols-1' : 'cols-2';
    const imgsHtml = images.map(img => `<img src="${escapeHtml(img.src)}">`).join('');
    mediaHtml = `<div class="tm-xpng-media ${colsClass}">${imgsHtml}</div>`;
  }

  const avatarSrc = data.avatarUrl || '';
  const qrDataUrl = data.tweetUrl ? generateQrDataUrl(data.tweetUrl) : '';

  const statsHtml = (data.replies || data.retweets || data.likes || data.views) ? `
    <div class="tm-xpng-stats">
      ${data.replies ? `<span><span class="tm-xpng-stat-val">${escapeHtml(data.replies)}</span>Replies</span>` : ''}
      ${data.retweets ? `<span><span class="tm-xpng-stat-val">${escapeHtml(data.retweets)}</span>Reposts</span>` : ''}
      ${data.likes ? `<span><span class="tm-xpng-stat-val">${escapeHtml(data.likes)}</span>Likes</span>` : ''}
      ${data.views ? `<span><span class="tm-xpng-stat-val">${escapeHtml(data.views)}</span>Views</span>` : ''}
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@500;700;900&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; }

  .tm-xpng-stage {
    position: relative;
    width: 1200px;
    padding: 80px;
    background: #ffffff;
    font-family: 'Noto Sans TC', ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    color: #000;
    border-radius: 28px;
  }

  .tm-xpng-row { display: flex; gap: 22px; }

  .tm-xpng-avatar {
    width: 92px; height: 92px; border-radius: 999px;
    background: #eee; flex: 0 0 auto; overflow: hidden;
  }
  .tm-xpng-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .tm-xpng-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .tm-xpng-name { font-weight: 900; font-size: 34px; line-height: 1.1; }
  .tm-xpng-handle { font-size: 26px; opacity: .70; font-weight: 700; }
  .tm-xpng-time { font-size: 24px; opacity: .60; font-weight: 700; }

  .tm-xpng-body {
    margin-top: 18px;
    font-size: 38px;
    line-height: 1.55;
    letter-spacing: .2px;
    white-space: normal;
    word-break: break-word;
    font-weight: 900;
  }

  .tm-hl {
    display: inline;
    padding: 0.06em 0.18em;
    border-radius: 0.18em;
    background: linear-gradient(transparent 58%, rgba(255, 242, 0, 0.95) 58%);
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  .tm-xpng-media { margin-top: 24px; display: grid; gap: 8px; border-radius: 16px; overflow: hidden; }
  .tm-xpng-media.cols-1 { grid-template-columns: 1fr; }
  .tm-xpng-media.cols-2 { grid-template-columns: 1fr 1fr; }
  .tm-xpng-media img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .tm-xpng-stats {
    margin-top: 28px;
    display: flex;
    gap: 36px;
    font-size: 26px;
    font-weight: 700;
    color: #536471;
  }
  .tm-xpng-stat-val { color: #000; margin-right: 4px; }

  .tm-xpng-qr {
    position: absolute;
    top: 30px;
    right: 34px;
    width: 56px;
    height: 56px;
    opacity: 0.7;
  }
  .tm-xpng-qr img { width: 100%; height: 100%; display: block; }

  .tm-xpng-watermark {
    position: absolute;
    bottom: 24px;
    left: 32px;
    font-size: 18px;
    font-weight: 700;
    opacity: 0.18;
    color: #000;
    pointer-events: none;
    user-select: none;
  }
</style>
</head>
<body>
<div class="tm-xpng-stage">
  ${qrDataUrl ? `<div class="tm-xpng-qr"><img src="${escapeHtml(qrDataUrl)}"></div>` : ''}
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
      ${statsHtml}
    </div>
  </div>
  <div class="tm-xpng-watermark">XCard</div>
</div>
</body>
</html>`;
}

// ==================== Puppeteer Renderer ====================

async function renderCard(html) {
  await ensureBrowser();
  let page;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.setContent(html, { waitUntil: 'networkidle2', timeout: 15000 });

    await page.evaluateHandle(() => document.fonts.ready);
    // Brief pause for font rendering to settle
    await new Promise(r => setTimeout(r, 500));

    const stageEl = await page.$('.tm-xpng-stage');
    if (!stageEl) {
      throw new Error('Card stage element not found');
    }

    const pngBuffer = await stageEl.screenshot({ type: 'png', omitBackground: true });
    return Buffer.from(pngBuffer);
  } catch (error) {
    if (browser && !browser.connected) {
      browser = null;
    }
    throw error;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

// ==================== Entry Point ====================

async function generateCardFromData(data) {
  const cnText = await translateText(data.text, 'zh-TW');
  const html = buildCardHtml({ ...data, cnText });
  return renderCard(html);
}

async function generateCard(tweetUrl) {
  const data = await fetchTweet(tweetUrl);
  return generateCardFromData(data);
}

module.exports = {
  generateCard,
  generateCardFromData,
  fetchTweet,
  translateText,
  buildCardHtml,
  renderCard,
  ensureBrowser,
  closeBrowser,
};
