/**
 * Social Writer — AI-powered social media post generator
 *
 * 流程：搜尋背景資料 → 餵給 AI → 產出短文案
 * Uses MEEI (dynamic import for ESM→CJS interop) to call AI providers.
 */

const SEARCH_TIMEOUT = 8_000;
const SEARCH_MAX_RESULTS = 3;

const SYSTEM_PROMPT = `你是社群文案寫手。根據推文內容和搜尋到的背景資料，寫一段簡短的繁體中文社群貼文。

嚴格規則：
- 50 到 100 字（不含連結）
- 只寫你有根據的事實，禁止自己編造、腦補、延伸推測
- 口語化，像跟朋友講話，不要文謅謅
- 直接講重點，不要廢話開場
- 最多 1 個 emoji
- 不要 hashtag
- 結尾附推文連結（純網址，不要 markdown）
- 禁止用「看到一則推文」「分享一下」「最近注意到」這類 AI 味開頭`;

let meeiChat = null;

async function getChat() {
  if (meeiChat) return meeiChat;

  try {
    const meei = await import('file:///C:/Users/jeffb/Desktop/code/MEEI/nodejs/dist/index.js');
    if (!meei.chat) {
      throw new Error('MEEI module loaded but chat not found');
    }
    meeiChat = meei.chat;
    return meeiChat;
  } catch (error) {
    throw new Error(`Failed to load MEEI: ${error.message}`);
  }
}

// ==================== Web Search ====================

async function searchDuckDuckGo(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return [];

    const html = await res.text();
    const snippets = [];
    const regex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null && snippets.length < SEARCH_MAX_RESULTS) {
      const clean = match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (clean) snippets.push(clean);
    }

    return snippets;
  } catch (err) {
    console.error('[Social Writer] Search error:', err.message);
    return [];
  }
}

function buildSearchQuery(data) {
  // Use author name + first ~80 chars of tweet text as search query
  const textSnippet = data.text.replace(/https?:\/\/\S+/g, '').trim().slice(0, 80);
  return `${data.displayName} ${textSnippet}`;
}

// ==================== Prompt ====================

function buildPrompt(data, searchContext) {
  const parts = [
    `推文作者：${data.displayName} (${data.handle})`,
    `推文內容：${data.text}`,
    `連結：${data.tweetUrl}`,
  ];

  if (data.likes) parts.push(`按讚數：${data.likes}`);
  if (data.retweets) parts.push(`轉推數：${data.retweets}`);

  if (searchContext) {
    parts.push('', '--- 搜尋到的背景資料 ---', searchContext);
    parts.push('', '（請根據以上背景資料理解推文脈絡，但只寫你確定的事實）');
  }

  return parts.join('\n');
}

// ==================== Generate ====================

/**
 * Generate a social media post from tweet data using AI.
 *
 * @param {object} tweetData - Tweet data from xcard.fetchTweet()
 * @param {object} config - Config with aiProvider and aiApiKey
 * @returns {Promise<string>} Generated social post text
 */
async function generate(tweetData, config) {
  const provider = config.aiProvider || 'deepseek';

  const envMap = {
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    chatgpt: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    qwen: 'QWEN_API_KEY',
    grok: 'GROQ_API_KEY',
    groq: 'GROQ_API_KEY',
  };

  const envKey = envMap[provider];
  if (envKey && config.aiApiKey) {
    process.env[envKey] = config.aiApiKey;
  }

  // Step 1: Search for background context
  const searchQuery = buildSearchQuery(tweetData);
  const snippets = await searchDuckDuckGo(searchQuery);
  const searchContext = snippets.length > 0 ? snippets.join('\n') : '';

  if (searchContext) {
    console.log(`[Social Writer] Found ${snippets.length} search results for context`);
  } else {
    console.log('[Social Writer] No search results, generating without context');
  }

  // Step 2: Generate with AI
  const chat = await getChat();
  const prompt = buildPrompt(tweetData, searchContext);

  const result = await chat.ask(prompt, {
    pv: provider,
    system: SYSTEM_PROMPT,
    temperature: 0.4,
    maxTokens: 300,
  });

  return result;
}

module.exports = { generate };
