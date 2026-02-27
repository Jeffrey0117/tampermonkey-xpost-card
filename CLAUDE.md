# XCard

Tweet-to-card PNG generator + AI social post writer.

## Stack

- Node.js (CJS)
- Puppeteer (card rendering)
- FxTwitter API (tweet fetching)
- Google Translate API (translation)
- MEEI module (multi-provider AI: DeepSeek, OpenAI, Gemini, Qwen, Groq)
- Port: 4009

## Run

```bash
node server.js    # HTTP API server (+ optional Telegram bot)
```

## Key Files

```
server.js              — HTTP API server (3 endpoints + health)
bot/
  index.js             — Entry point (exports startBot, stopBot)
  xcard.js             — Core: fetchTweet, generateCard, translateText, renderCard
  xcard-bot.js         — Telegram bot (URL detection, inline buttons)
  social-writer.js     — AI social post generator (DuckDuckGo research + LLM)
```

## API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/generate` | Tweet URL → base64 PNG card + metadata |
| POST | `/api/fetch` | Tweet URL → raw tweet data (no rendering) |
| POST | `/api/social` | Tweet URL → AI social media post (Traditional Chinese) |
| GET | `/api/health` | Health check |

All POST endpoints accept `{ "tweetUrl": "https://x.com/user/status/123" }`.

## Core Functions

| Function | Input | Output |
|----------|-------|--------|
| `generateCard(url)` | Tweet URL | PNG Buffer |
| `fetchTweet(url)` | Tweet URL | Tweet data object |
| `generateCardFromData(data)` | Tweet data | PNG Buffer |
| `translateText(text, lang)` | Text + lang code | Translated text |
| `socialWriter.generate(data, config)` | Tweet data + AI config | Social post string |

## Card Specs

- 1200x1360px PNG
- Avatar, display name, handle, timestamp
- Translated text (yellow highlight)
- Tweet images (up to 4, grid layout)
- Engagement stats (replies, reposts, likes, views)
- QR code linking to original tweet
- XCard watermark

## Config

Create `config.json` in project root:

```json
{
  "botToken": "telegram-bot-token",
  "chatId": "123456789",
  "aiProvider": "deepseek",
  "aiApiKey": "your-api-key"
}
```

## CloudPipe Integration

- Manifest: `data/manifests/xcard.json` (3 tools)
- Auth: none
- Entry: `server.js`
- Also loaded as Telegram bot via `config.xcard.botPath` in CloudPipe
- CloudPipe `services/xcard.js` provides userscript → Telegram bridge
- MEEI module path: `C:\Users\jeffb\Desktop\code\MEEI\`
