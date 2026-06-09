const puppeteer = require('puppeteer');

let browserPromise = null;

async function launch() {
    return puppeteer.launch({
        headless: 'new',
        // Accept self-signed / untrusted TLS certs (e.g. LocalWP's https://*.local sites).
        acceptInsecureCerts: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--ignore-certificate-errors',
        ],
    });
}

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = launch().then((browser) => {
            browser.on('disconnected', () => {
                browserPromise = null;
            });
            return browser;
        }).catch((err) => {
            browserPromise = null;
            throw err;
        });
    }
    return browserPromise;
}

async function closeBrowser() {
    if (browserPromise) {
        const browser = await browserPromise.catch(() => null);
        browserPromise = null;
        if (browser) await browser.close().catch(() => {});
    }
}

module.exports = { getBrowser, closeBrowser };
