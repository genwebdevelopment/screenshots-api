const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getBrowser } = require('./browser');

const SELECTORS = {
    hero: { viewportCapture: true, scrollTo: 0, clipHeight: 900, name: 'Hero Section' },
    slider: { selector: '#find-services, .services-sec, .looking-for-today-slider', name: 'Service Slider' },
    map: { selector: '#vmap, .us-map, [class*="map-section"], .state-map', name: 'US Map' },
    footer: { selector: 'footer, .elementor-location-footer, [data-elementor-type="footer"]', name: 'Footer' },
};

function newJobId() {
    return crypto.randomBytes(8).toString('hex');
}

// Disable animations, transitions and smooth-scroll so two captures of an unchanged
// page produce byte-identical pixels (otherwise carousels/transitions cause false diffs).
const STABILIZE_CSS = `*,*::before,*::after{animation:none!important;animation-duration:0s!important;animation-delay:0s!important;transition:none!important;transition-duration:0s!important;caret-color:transparent!important}html{scroll-behavior:auto!important}`;

// Scroll the full height to trigger lazy-loaded images, then return to the top.
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let total = 0;
            const step = 400;
            const timer = setInterval(() => {
                window.scrollBy(0, step);
                total += step;
                if (total >= document.body.scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 80);
        });
        window.scrollTo(0, 0);
    });
}

async function capture({ url, sections = ['full'], viewport, waitTime = 3000, timeout = 60000, outputRoot, hide = [] }) {
    const jobId = newJobId();
    const outputDir = path.join(outputRoot, jobId);
    fs.mkdirSync(outputDir, { recursive: true });

    const vp = { width: 1920, height: 1080, deviceScaleFactor: 1, ...(viewport || {}) };
    const browser = await getBrowser();
    const page = await browser.newPage();
    const results = [];

    try {
        await page.setViewport(vp);
        // networkidle2 waits for the page to settle (images/fonts/XHR) — important for
        // consistent before/after captures, not just the initial DOM.
        await page.goto(url, { waitUntil: 'networkidle2', timeout });
        await page.addStyleTag({ content: STABILIZE_CSS }).catch(() => {});
        await autoScroll(page).catch(() => {});
        // Wait for web fonts to finish so text doesn't shift between captures.
        await page.evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready : null)).catch(() => {});
        // Hide dynamic/volatile regions (dates, ads, cookie banners) the caller wants ignored.
        if (Array.isArray(hide) && hide.length) {
            await page.evaluate((sels) => {
                for (const sel of sels) {
                    document.querySelectorAll(sel).forEach((el) => { el.style.visibility = 'hidden'; });
                }
            }, hide).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, waitTime));

        for (const key of sections) {
            if (key === 'full') {
                const filename = 'full-page.png';
                // captureBeyondViewport:false makes Puppeteer resize the real viewport to the
                // full page height and capture within it. The default (true) uses an off-screen
                // surface that renders blank on some sites (e.g. animated/lazy pages like jovie.com).
                //
                // Wrapped like the per-section captures below: an unguarded throw here aborted
                // the whole job, so a very tall page (jovie.com/blog/ renders ~18,800px) took
                // every other requested section down with it and surfaced no reason at all.
                try {
                    await page.screenshot({ path: path.join(outputDir, filename), fullPage: true, captureBeyondViewport: false });
                    results.push({ section: 'full', filename });
                } catch (err) {
                    results.push({ section: 'full', error: err.message });
                }
                continue;
            }

            const section = SELECTORS[key];
            if (!section) continue;

            const filename = `${key}.png`;
            const filepath = path.join(outputDir, filename);

            try {
                if (section.viewportCapture) {
                    await page.evaluate((y) => window.scrollTo(0, y), section.scrollTo || 0);
                    await new Promise((r) => setTimeout(r, 500));
                    await page.screenshot({
                        path: filepath,
                        clip: { x: 0, y: 0, width: vp.width, height: section.clipHeight || 900 },
                    });
                } else {
                    const selectors = section.selector.split(',').map((s) => s.trim());
                    let element = null;
                    for (const sel of selectors) {
                        element = await page.$(sel);
                        if (element) break;
                    }
                    if (!element) {
                        results.push({ section: key, error: 'element_not_found' });
                        continue;
                    }
                    await page.evaluate((el) => el.scrollIntoView({ behavior: 'instant', block: 'center' }), element);
                    await new Promise((r) => setTimeout(r, 500));
                    await element.screenshot({ path: filepath });
                }
                results.push({ section: key, filename });
            } catch (err) {
                results.push({ section: key, error: err.message });
            }
        }

        return { jobId, outputDir, results };
    } catch (err) {
        // A thrown error (e.g. the goto() timeout below) would otherwise reach
        // server.js with no way to know which job/folder it belonged to — the
        // caller then can't ever delete it, and it leaks on disk forever.
        err.jobId = jobId;
        throw err;
    } finally {
        await page.close().catch(() => {});
    }
}

module.exports = { capture, SELECTORS };
