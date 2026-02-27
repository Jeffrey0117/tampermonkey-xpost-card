/**
 * XCard HTTP API Server
 *
 * Exposes XCard functions as HTTP endpoints for CloudPipe gateway/pipeline.
 * Also optionally starts the Telegram bot if configured.
 *
 * Endpoints:
 *   POST /api/generate    — tweet URL → card PNG (base64) + metadata
 *   POST /api/fetch       — tweet URL → tweet data (no card)
 *   POST /api/social      — tweet URL → AI social post text
 *   GET  /api/health      — health check
 */

const http = require('http')
const path = require('path')
const fs = require('fs')

const xcard = require('./bot/xcard')
const socialWriter = require('./bot/social-writer')

const PORT = process.env.PORT || 4009

// ==================== Helpers ====================

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.json')
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

function validateTweetUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    const validHosts = ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com', 'mobile.twitter.com', 'mobile.x.com']
    return validHosts.includes(parsed.hostname) && /\/status\/\d+/.test(parsed.pathname)
  } catch {
    return false
  }
}

// ==================== Route Handlers ====================

async function handleGenerate(req, res) {
  const body = await collectBody(req)
  const { tweetUrl } = body

  if (!validateTweetUrl(tweetUrl)) {
    return json(res, 400, { error: 'Invalid or missing tweetUrl (expected x.com/twitter.com status URL)' })
  }

  const tweetData = await xcard.fetchTweet(tweetUrl)
  const pngBuffer = await xcard.generateCardFromData(tweetData)

  return json(res, 200, {
    success: true,
    image: pngBuffer.toString('base64'),
    metadata: {
      displayName: tweetData.displayName,
      handle: tweetData.handle,
      text: tweetData.text,
      tweetUrl: tweetData.tweetUrl,
      likes: tweetData.likes,
      retweets: tweetData.retweets
    }
  })
}

async function handleFetch(req, res) {
  const body = await collectBody(req)
  const { tweetUrl } = body

  if (!validateTweetUrl(tweetUrl)) {
    return json(res, 400, { error: 'Invalid or missing tweetUrl' })
  }

  const tweetData = await xcard.fetchTweet(tweetUrl)
  return json(res, 200, { success: true, data: tweetData })
}

async function handleSocial(req, res) {
  const body = await collectBody(req)
  const { tweetUrl } = body

  if (!validateTweetUrl(tweetUrl)) {
    return json(res, 400, { error: 'Invalid or missing tweetUrl' })
  }

  const config = loadConfig()
  if (!config.aiProvider || !config.aiApiKey) {
    return json(res, 500, { error: 'aiProvider and aiApiKey not configured in config.json' })
  }

  const tweetData = await xcard.fetchTweet(tweetUrl)
  const post = await socialWriter.generate(tweetData, config)

  return json(res, 200, { success: true, post, tweetUrl: tweetData.tweetUrl })
}

// ==================== Server ====================

const routes = {
  'POST /api/generate': handleGenerate,
  'POST /api/fetch': handleFetch,
  'POST /api/social': handleSocial,
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // Health check
  if (req.method === 'GET' && req.url === '/api/health') {
    return json(res, 200, { status: 'ok', service: 'xcard' })
  }

  // Route matching
  const url = req.url.split('?')[0]
  const key = `${req.method} ${url}`
  const handler = routes[key]

  if (!handler) {
    return json(res, 404, { error: 'Not found' })
  }

  try {
    await handler(req, res)
  } catch (err) {
    console.error(`[xcard] ${key} error:`, err.message)
    json(res, 500, { error: err.message })
  }
})

server.listen(PORT, () => {
  console.log(`[xcard] HTTP API listening on :${PORT}`)

  // Optionally start Telegram bot
  const config = loadConfig()
  if (config.botToken && config.chatId) {
    const { startBot } = require('./bot')
    startBot(config)
    console.log('[xcard] Telegram bot started')
  }
})
