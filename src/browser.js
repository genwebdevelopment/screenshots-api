const puppeteer = require('puppeteer');

let browserPromise = null;

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
        const promise = browserPromise;
        browserPromise = null;
        const browser = await promise.catch(() => null);
        if (!browser) return;
        try {
            // A wedged (but still "connected") browser can hang on the graceful
            // CDP close too, so bound it and fall back to killing the process
            // directly — otherwise a dead browser never gets replaced.
            await withTimeout(browser.close(), 5000, 'browser.close timed out');
        } catch (err) {
            const proc = browser.process();
            if (proc) proc.kill('SIGKILL');
        }
    }
}

// Requests to a wedged-but-still-connected browser (e.g. one choking on
// rendering a very tall page) just hang forever with no timeout of their own,
// which is what let earlier requests queue up for minutes behind a dead
// browser. Bound the call and, if it trips, kill the browser so the *next*
// request gets a fresh one instead of piling up behind the same one.
async function getPage(timeoutMs = 30000) {
    const browser = await getBrowser();
    try {
        return await withTimeout(browser.newPage(), timeoutMs, 'browser.newPage() timed out — browser is unresponsive');
    } catch (err) {
        await closeBrowser();
        throw err;
    }
}

module.exports = { getBrowser, getPage, closeBrowser };
