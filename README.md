# screenshot-api

Standalone Node + Puppeteer HTTP service for capturing screenshots. Designed to run on a Hostinger VPS and be called from the `agents-dashboard` WordPress plugin (which runs on Kinsta where `shell_exec` is blocked).

## Local dev

```bash
cp .env.example .env
# edit .env and set a strong API_KEY
npm install
npm start
```

Test:

```bash
curl -X POST http://localhost:3000/screenshot \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -d '{"url":"https://example.com","sections":["full"]}'
```

## API

### `GET /health`
Returns `{ ok: true, queued: N }`.

### `POST /screenshot` (requires `x-api-key` header)

Body:
```json
{
  "url": "https://example.com",
  "sections": ["full", "hero", "slider", "map", "footer"],
  "viewport": { "width": 1920, "height": 1080 },
  "waitTime": 3000,
  "timeout": 60000
}
```

Response:
```json
{
  "jobId": "abc123",
  "files": [
    { "section": "full", "filename": "full-page.png", "url": "http://host/files/abc123/full-page.png" }
  ]
}
```

### `GET /files/:jobId/:filename`
Static access to captured PNGs.

### `POST /diff` (requires `x-api-key` header)

Stateless visual comparison of two PNGs. The caller (the WP plugin) already
holds the previous and latest screenshots locally, so it uploads both as base64
and gets back a full-resolution `pixelmatch` diff. Unlike `/compare`, no prior
job is needed.

Body:
```json
{
  "before": "<base64 PNG>",
  "after":  "<base64 PNG>",
  "threshold": 0.1,
  "changedRatio": 0.02,
  "saveDiffImage": false
}
```
- `threshold` — pixelmatch per-pixel sensitivity, 0 (strict) – 1 (loose). Default `0.1`.
- `changedRatio` — fraction of differing pixels above which `changed` is true. Default `0.001`.
- `saveDiffImage` — when `true`, writes a red-highlighted diff PNG and returns its URL. Default `false` (the plugin highlights regions itself, so skipping the write avoids leaking `diff-*/` folders on disk).

Response:
```json
{
  "id": "diff-…",
  "changed": true,
  "diffPercent": 25.885,
  "diffPixels": 12867099,
  "totalPixels": 49708800,
  "sizeMismatch": true,
  "dimsBefore": { "width": 1920, "height": 16440 },
  "dimsAfter":  { "width": 1920, "height": 25890 },
  "regions": [ { "top": 626, "left": 60, "width": 1800, "height": 400, "changedPixels": 428606 } ],
  "diffUrl": null
}
```
`regions` are bounding bands of changed pixels in the common (max-of-both) image
space; the plugin converts them to per-pane percentages to box the change on
both the Previous and Latest screenshots.

Both captures are padded to a common size before diffing, so a height change
(e.g. the page grew) surfaces as changed pixels rather than an error.

## Hostinger VPS deployment

1. **Pick VPS plan with ≥2GB RAM** (Chrome is memory-hungry).
2. SSH in, install Node 20+ and Chromium dependencies:
   ```bash
   sudo apt update
   sudo apt install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
     libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
     libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
     libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
     libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
     libxss1 libxtst6 lsb-release wget xdg-utils
   ```
3. Clone/upload this folder, then:
   ```bash
   cd screenshot-api
   cp .env.example .env
   nano .env   # set API_KEY, PUBLIC_BASE_URL, PORT
   npm ci --omit=dev
   npm install -g pm2
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup        # follow printed instructions to enable on boot
   ```
4. Open firewall port (or put behind nginx + Let's Encrypt for HTTPS — recommended).
5. From the WP plugin, call `POST https://your-domain/screenshot` with the API key.

## Notes

- Browser instance is reused across requests for speed.
- Concurrency is limited by `MAX_CONCURRENCY` (default 2). Raise only if RAM allows (~500MB per concurrent Chrome).
- Screenshots persist on disk under `SCREENSHOT_DIR`. Add a cron to prune old jobs:
  ```
  find /path/to/screenshots -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
  ```
- For production, put nginx in front to handle HTTPS and rate limiting.
