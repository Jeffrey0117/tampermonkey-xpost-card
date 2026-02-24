# tampermonkey-xpost-card

Tampermonkey userscript that adds a **PNG** button to every X (Twitter) post. One click to auto-translate the tweet into Traditional Chinese, render a clean highlight card, and download as PNG.

## Features

- Auto-translate to Traditional Chinese (Google Translate, no API key needed)
- Neon-yellow highlighter effect on text
- Displays engagement stats (replies, reposts, likes, views)
- Subtle "XCard" watermark
- One-click PNG download (2x resolution)

## Preview

![preview](assets/preview-v2.png)

1. Click the **PNG** button on any tweet action bar
2. Tweet text is auto-translated to zh-TW
3. A card preview appears with highlighted Chinese text
4. Click **Download PNG** to save

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Click **Create a new script** in Tampermonkey dashboard
3. Paste the contents of `xcard.user.js`
4. Save (Ctrl+S)
5. Visit [x.com](https://x.com) — every tweet now has a **PNG** button

## Requirements

- Tampermonkey (Chrome / Firefox / Edge)
- Grants: `GM_addStyle`, `GM_download`, `GM_xmlhttpRequest`
- External: [html2canvas](https://html2canvas.hertzen.com/) (loaded via CDN)

## License

MIT
