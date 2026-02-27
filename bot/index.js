/**
 * XCard Bot — Entry Point
 *
 * 用法：
 *   // 被外部引用（如 CloudPipe）
 *   const xcardBot = require('./bot');
 *   xcardBot.startBot({ botToken, chatId, ... });
 *
 *   // 獨立使用（讀取同目錄 config.json）
 *   const xcardBot = require('./bot');
 *   xcardBot.startBot();
 */

const { startBot, stopBot } = require('./xcard-bot');

module.exports = { startBot, stopBot };
