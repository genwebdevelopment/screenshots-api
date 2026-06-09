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

async function capture({ url, sections = ['full'], viewport, waitTime = 3000, timeout = 60000, outputRoot }) {
    const jobId = newJobId();
    const outputDir = path.join(outputRoot, jobId);
    fs.mkdirSync(outputDir, { recursive: true });

    const vp = { width: 1920, height: 1080, ...(viewport || {}) };
    const browser = await getBrowser();
    const page = await browser.newPage();
    const results = [];

    try {
        await page.setViewport(vp);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        await new Promise((r) => setTimeout(r, waitTime));

        for (const key of sections) {
            if (key === 'full') {
                const filename = 'full-page.png';
                await page.screenshot({ path: path.join(outputDir, filename), fullPage: true });
                results.push({ section: 'full', filename });
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
    } finally {
        await page.close().catch(() => {});
    }
}

module.exports = { capture, SELECTORS };
