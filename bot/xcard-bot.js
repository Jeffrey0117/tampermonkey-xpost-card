/**
 * XCard Telegram Bot
 *
 * 獨立的 Telegram bot，貼推文連結自動回傳 XCard PNG + AI 社群貼文。
 *
 * Config 來源（Plan B）：
 *   - 外部注入：startBot(config) 傳入（被 CloudPipe 引用時）
 *   - 獨立使用：讀取同目錄的 config.json
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const xcard = require('./xcard');
const socialWriter = require('./social-writer');

function getApiBase() {
  const proxy = activeConfig.telegramProxy;
  return proxy ? `${proxy.replace(/\/+$/, '')}/bot` : 'https://api.telegram.org/bot';
}
const XCARD_TIMEOUT = 45_000;

let polling = false;
let pollTimeout = null;
let pollInFlight = false;
let lastUpdateId = 0;
let xcardInProgress = false;

/** @type {Map<string, {tweetUrl: string, tweetData: object}>} */
const lastTweetMap = new Map();

/** @type {object} */
let activeConfig = {};

// ==================== Config ====================

function loadLocalConfig() {
  const localPath = path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  } catch {
    return {};
  }
}

function getConfig() {
  return activeConfig;
}

// ==================== Telegram API ====================

function httpsPost(url, data, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: chunks });
      });
    });
    req.on('error', reject);
    req.setTimeout(90_000, () => { req.destroy(new Error('Request timeout')); });
    req.end(body);
  });
}

async function apiCall(method, body = {}) {
  const { botToken } = getConfig();
  if (!botToken) return null;

  const res = await httpsPost(
    `${getApiBase()}${botToken}/${method}`,
    body,
  );

  if (res.status !== 200) {
    console.error(`[XCard Bot] API error (${method}):`, res.body);
    if (res.status === 409) return { _conflict: true };
    return null;
  }

  return JSON.parse(res.body);
}

async function sendMessage(chatId, text, options = {}) {
  return apiCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

async function deleteMessage(chatId, messageId) {
  return apiCall('deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
}

async function sendPhoto(chatId, photoBuffer, replyMarkup) {
  const { botToken } = getConfig();
  if (!botToken) return null;

  const boundary = '----XCardBoundary' + Date.now();
  const parts = [];

  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="xcard.png"\r\nContent-Type: image/png\r\n\r\n`);
  if (replyMarkup) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="reply_markup"\r\n\r\n${JSON.stringify(replyMarkup)}`);
  }

  const buffers = [
    Buffer.from(parts[0] + '\r\n'),
    Buffer.from(parts[1]),
    photoBuffer,
    Buffer.from('\r\n'),
  ];
  if (replyMarkup) {
    buffers.push(Buffer.from(parts[2] + '\r\n'));
  }
  buffers.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(buffers);

  return new Promise((resolve, reject) => {
    const parsed = new URL(`${getApiBase()}${botToken}/sendPhoto`);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error('[XCard Bot] sendPhoto error:', chunks);
          resolve(null);
          return;
        }
        try { resolve(JSON.parse(chunks)); } catch { resolve(null); }
      });
    });
    req.on('error', (err) => {
      console.error('[XCard Bot] sendPhoto network error:', err.message);
      resolve(null);
    });
    req.setTimeout(60_000, () => { req.destroy(new Error('sendPhoto timeout')); });
    req.end(body);
  });
}

async function answerCallbackQuery(callbackQueryId, text) {
  return apiCall('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}

// ==================== XCard Handler ====================

function isAuthorized(chatId) {
  const config = getConfig();
  if (!config.chatId) return false;
  return String(chatId) === String(config.chatId);
}

async function handleXCard(chatId, tweetUrl) {
  if (xcardInProgress) {
    await sendMessage(chatId, '⏳ 另一張 XCard 正在生成中，請稍候...');
    return;
  }

  xcardInProgress = true;
  const statusMsg = await sendMessage(chatId, '⏳ 生成 XCard 中...');
  const statusMsgId = statusMsg?.result?.message_id;
  const config = getConfig();

  try {
    const tweetData = await Promise.race([
      xcard.fetchTweet(tweetUrl),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Tweet fetch timed out')), XCARD_TIMEOUT)
      ),
    ]);

    const tasks = [xcard.generateCardFromData(tweetData)];
    if (config.aiProvider && config.aiApiKey) {
      tasks.push(socialWriter.generate(tweetData, config));
    }

    const [cardResult, socialResult] = await Promise.allSettled(tasks);

    if (cardResult.status === 'fulfilled') {
      const pngBuffer = cardResult.value;
      if (!pngBuffer || pngBuffer.length === 0) {
        throw new Error('Generated card image was empty');
      }
      const regenMarkup = {
        inline_keyboard: [[
          { text: '\u{1F504} 重新生成', callback_data: 'regen' },
          { text: '\u270D\uFE0F 重寫文案', callback_data: 'rewrite_social' },
        ]],
      };
      const photoResult = await sendPhoto(chatId, pngBuffer, regenMarkup);
      if (!photoResult) {
        throw new Error('Failed to upload photo to Telegram');
      }
      lastTweetMap.set(String(chatId), { tweetUrl, tweetData });
    } else {
      throw cardResult.reason;
    }

    if (socialResult && socialResult.status === 'fulfilled' && socialResult.value) {
      await sendMessage(chatId, socialResult.value);
    } else if (socialResult && socialResult.status === 'rejected') {
      console.error('[XCard Bot] AI social post failed:', socialResult.reason?.message);
    }
  } catch (err) {
    console.error('[XCard Bot] Error:', err);
    lastTweetMap.set(String(chatId), { tweetUrl, tweetData: null });
    await sendMessage(chatId, '❌ XCard 生成失敗，請確認連結是否為有效推文。', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔄 重試', callback_data: 'retry' },
        ]],
      },
    });
  } finally {
    xcardInProgress = false;
    if (statusMsgId) {
      deleteMessage(chatId, statusMsgId).catch((err) => {
        console.warn('[XCard Bot] Failed to delete status message:', err.message);
      });
    }
  }
}

// ==================== Start / Help ====================

async function handleStart(chatId) {
  const text = [
    '<b>XCard Bot</b>',
    '',
    '貼一個 X/Twitter 推文連結，我就幫你生成：',
    '  - XCard 圖片（翻譯 + 排版）',
    '  - AI 社群文案',
    '',
    '輸入 /help 查看所有指令。',
  ].join('\n');
  await sendMessage(chatId, text);
}

async function handleHelp(chatId) {
  const text = [
    '<b>指令列表</b>',
    '',
    '直接貼連結 — 生成 XCard 圖片 + AI 文案',
    '/rewrite &lt;連結&gt; — 只重寫 AI 社群文案',
    '/help — 顯示此說明',
    '',
    '<b>圖片按鈕</b>',
    '🔄 重新生成 — 重新產生卡片',
    '✍️ 重寫文案 — 重新產生 AI 文案',
  ].join('\n');
  await sendMessage(chatId, text);
}

// ==================== Rewrite Handler ====================

async function handleRewrite(chatId, url) {
  if (!url) {
    await sendMessage(chatId, '用法：/rewrite &lt;推文連結&gt;\n\n例如：\n/rewrite https://x.com/xxx/status/123');
    return;
  }

  const tweetMatch = url.match(/https?:\/\/(?:x\.com|twitter\.com)\/\w+\/status\/\d+/);
  if (!tweetMatch) {
    await sendMessage(chatId, '❌ 請提供有效的 X/Twitter 推文連結。');
    return;
  }

  const config = getConfig();
  if (!config.aiProvider || !config.aiApiKey) {
    await sendMessage(chatId, '❌ 未設定 AI，無法生成文案。');
    return;
  }

  const statusMsg = await sendMessage(chatId, '✍️ AI 文案生成中...');
  const statusMsgId = statusMsg?.result?.message_id;

  try {
    const tweetData = await xcard.fetchTweet(tweetMatch[0]);
    lastTweetMap.set(String(chatId), { tweetUrl: tweetMatch[0], tweetData });

    const result = await socialWriter.generate(tweetData, config);
    if (result) {
      await sendMessage(chatId, result);
    } else {
      await sendMessage(chatId, '❌ AI 文案生成失敗，請再試一次。');
    }
  } catch (err) {
    console.error('[XCard Bot] Rewrite error:', err);
    await sendMessage(chatId, '❌ 文案生成失敗，請確認連結是否為有效推文。');
  } finally {
    if (statusMsgId) {
      deleteMessage(chatId, statusMsgId).catch(() => {});
    }
  }
}

// ==================== Regen Handler ====================

async function handleRegen(chatId, callbackQueryId) {
  const last = lastTweetMap.get(String(chatId));
  if (!last) {
    await answerCallbackQuery(callbackQueryId, '沒有可重新生成的推文');
    return;
  }

  await answerCallbackQuery(callbackQueryId);
  return handleXCard(chatId, last.tweetUrl);
}

// ==================== Rewrite Social Handler ====================

async function handleRewriteSocial(chatId, callbackQueryId) {
  const last = lastTweetMap.get(String(chatId));
  if (!last) {
    await answerCallbackQuery(callbackQueryId, '沒有可重寫的推文');
    return;
  }

  const config = getConfig();
  if (!config.aiProvider || !config.aiApiKey) {
    await answerCallbackQuery(callbackQueryId, '未設定 AI，無法生成文案');
    return;
  }

  await answerCallbackQuery(callbackQueryId, '✍️ 重新生成文案中...');

  try {
    const result = await socialWriter.generate(last.tweetData, config);
    if (result) {
      await sendMessage(chatId, result);
    } else {
      await sendMessage(chatId, '❌ AI 文案生成失敗，請再試一次。');
    }
  } catch (err) {
    console.error('[XCard Bot] Rewrite social error:', err);
    await sendMessage(chatId, '❌ AI 文案生成失敗，請再試一次。');
  }
}

// ==================== Update Handler ====================

async function handleUpdate(update) {
  // Handle inline button callbacks
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    if (!chatId || !isAuthorized(chatId)) return;

    if (cb.data === 'regen' || cb.data === 'retry') {
      return handleRegen(chatId, cb.id);
    }
    if (cb.data === 'rewrite_social') {
      return handleRewriteSocial(chatId, cb.id);
    }
    return;
  }

  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  if (!isAuthorized(chatId)) return;

  const text = message.text.trim();

  const [command, ...args] = text.split(/\s+/);

  // /start 歡迎訊息
  if (command === '/start') {
    return handleStart(chatId);
  }

  // /help 指令列表
  if (command === '/help') {
    return handleHelp(chatId);
  }

  // /rewrite <URL> — 只重寫文案（不生成卡片）
  if (command === '/rewrite') {
    return handleRewrite(chatId, args[0]);
  }

  // 偵測推文連結
  const tweetMatch = text.match(/(?:^|\s)(https?:\/\/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+))/);
  if (tweetMatch) {
    return handleXCard(chatId, tweetMatch[1]);
  }

  // 非連結文字，給提示
  await sendMessage(chatId, '請貼一個推文連結或使用 /help 查看指令。');
}

// ==================== Long Polling ====================

async function clearStaleConnections() {
  try {
    await apiCall('deleteWebhook', { drop_pending_updates: false });
    // Short poll (timeout:0) to flush any lingering getUpdates session
    const flush = await apiCall('getUpdates', { offset: -1, timeout: 0 });
    if (flush?.result?.length > 0) {
      lastUpdateId = flush.result[flush.result.length - 1].update_id;
    }
    console.log('[XCard Bot] Cleared stale connections');
  } catch (err) {
    console.error('[XCard Bot] clearStaleConnections error:', err.message);
  }
}

async function poll() {
  if (!polling || pollInFlight) return;

  const { botToken } = getConfig();
  if (!botToken) {
    pollTimeout = setTimeout(poll, 10000);
    return;
  }

  pollInFlight = true;
  let nextDelay = 1000;

  try {
    const data = await apiCall('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message', 'callback_query'],
    });

    if (data?._conflict) {
      // 409: another instance is polling — clear and back off longer
      console.log('[XCard Bot] 409 conflict detected, clearing stale connections...');
      await clearStaleConnections();
      nextDelay = 10000;
    } else if (!data) {
      // Other API error — back off
      nextDelay = 5000;
    } else if (data.result?.length > 0) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        handleUpdate(update).catch((err) => {
          console.error('[XCard Bot] Handle error:', err);
        });
      }
    }
  } catch (err) {
    console.error('[XCard Bot] Poll error:', err.message);
    nextDelay = 5000;
  } finally {
    pollInFlight = false;
  }

  if (polling) {
    pollTimeout = setTimeout(poll, nextDelay);
  }
}

// ==================== Lifecycle ====================

/**
 * 啟動 XCard Bot。
 * @param {object} [config] - 外部注入的設定。若未傳入，讀取本地 config.json。
 * @param {boolean} config.enabled
 * @param {string}  config.botToken
 * @param {string}  config.chatId
 * @param {string}  [config.aiProvider]
 * @param {string}  [config.aiApiKey]
 */
async function startBot(config) {
  activeConfig = config || loadLocalConfig();

  if (!activeConfig.enabled) {
    console.log('[XCard Bot] 未啟用 (enabled = false)');
    return;
  }

  if (!activeConfig.botToken) {
    console.log('[XCard Bot] 缺少 botToken，跳過啟動');
    return;
  }

  if (!activeConfig.chatId) {
    console.log('[XCard Bot] 缺少 chatId，跳過啟動');
    return;
  }

  // Clear any stale long-poll connections from a previous process
  await clearStaleConnections();

  // Register bot commands for Telegram UI menu
  await apiCall('setMyCommands', {
    commands: [
      { command: 'rewrite', description: '重寫 AI 社群文案（後接推文連結）' },
      { command: 'help', description: '顯示指令列表' },
    ],
  });

  polling = true;
  poll();
  console.log(`[XCard Bot] 已啟動 (chatId: ${activeConfig.chatId})`);
}

function stopBot() {
  polling = false;
  pollInFlight = false;
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  xcard.closeBrowser();
  console.log('[XCard Bot] 已停止');
}

module.exports = {
  startBot,
  stopBot,
};
