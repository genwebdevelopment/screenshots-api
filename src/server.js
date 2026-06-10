require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pLimit = require('p-limit');
const { capture } = require('./screenshot');
const { closeBrowser } = require('./browser');
const { JobStore } = require('./storage');
const { compareFiles } = require('./diff');
const { dirSize, rmRecursive } = require('./util');

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '2', 10);
const SCREENSHOT_DIR = path.resolve(process.env.SCREENSHOT_DIR || './screenshots');
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10);

if (!API_KEY || API_KEY === 'change-me-to-a-long-random-string') {
    console.error('FATAL: set API_KEY in .env');
    process.exit(1);
}

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const store = new JobStore(DATA_DIR);
const comparisons = new JobStore(DATA_DIR, 'comparisons.json');
const limit = pLimit(MAX_CONCURRENCY);

// A section counts as "changed" once more than this fraction of pixels differ,
// filtering out sub-pixel antialiasing noise.
const CHANGED_RATIO = 0.001;
const app = express();
app.use(express.json({ limit: '100kb' }));

function auth(req, res, next) {
    const key = req.header('x-api-key') || req.query.api_key;
    if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
    next();
}

function getClientIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
}

app.get('/health', (req, res) => {
    res.json({ ok: true, queued: limit.activeCount + limit.pendingCount });
});

app.use('/files', express.static(SCREENSHOT_DIR, { maxAge: '1d' }));
app.use('/dashboard', express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.redirect('/dashboard/'));

app.post('/screenshot', auth, async (req, res) => {
    const { url, sections, viewport, waitTime, timeout, hide } = req.body || {};
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'invalid_url' });
    }

    const startedAt = Date.now();
    const requestedSections = Array.isArray(sections) && sections.length ? sections : ['full'];
    const hideSelectors = Array.isArray(hide) ? hide.filter((s) => typeof s === 'string') : [];
    const clientIp = getClientIp(req);

    try {
        const result = await limit(() =>
            capture({
                url,
                sections: requestedSections,
                viewport,
                waitTime: Math.min(Math.max(parseInt(waitTime || 3000, 10), 0), 15000),
                timeout: Math.min(Math.max(parseInt(timeout || REQUEST_TIMEOUT_MS, 10), 5000), 120000),
                outputRoot: SCREENSHOT_DIR,
                hide: hideSelectors,
            })
        );

        const { bytes } = dirSize(result.outputDir);
        const files = result.results.map((r) => ({
            ...r,
            url: r.filename ? `${PUBLIC_BASE_URL}/files/${result.jobId}/${r.filename}` : undefined,
        }));

        const successCount = files.filter((f) => f.filename).length;
        const entry = {
            id: result.jobId,
            url,
            sections: requestedSections,
            viewport: viewport || null,
            status: successCount > 0 ? 'success' : 'failed',
            createdAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            fileCount: successCount,
            totalBytes: bytes,
            clientIp,
            files,
        };
        store.add(entry);

        res.json({ jobId: result.jobId, files });
    } catch (err) {
        console.error('screenshot error:', err);
        store.add({
            id: 'err-' + Date.now().toString(36),
            url,
            sections: requestedSections,
            status: 'failed',
            createdAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            error: err.message,
            clientIp,
            files: [],
        });
        res.status(500).json({ error: 'capture_failed', message: err.message });
    }
});

// ---------- Dashboard API ----------

app.get('/api/stats', auth, (req, res) => {
    const s = store.stats();
    const disk = dirSize(SCREENSHOT_DIR);
    res.json({ ...s, diskBytes: disk.bytes, diskFileCount: disk.count });
});

app.get('/api/jobs', auth, (req, res) => {
    const limitN = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const status = req.query.status;
    const { total, rows } = store.list({ limit: limitN, offset, status });
    const jobs = rows.map((j) => ({
        ...j,
        files: (j.files || []).map((f) => ({
            ...f,
            url: f.filename ? `${PUBLIC_BASE_URL}/files/${j.id}/${f.filename}` : undefined,
        })),
    }));
    res.json({ total, jobs });
});

app.get('/api/jobs/:id', auth, (req, res) => {
    const j = store.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'not_found' });
    res.json(j);
});

app.delete('/api/jobs/:id', auth, (req, res) => {
    const id = req.params.id;
    const removed = store.remove(id);
    rmRecursive(path.join(SCREENSHOT_DIR, id));
    res.json({ ok: true, removed });
});

app.post('/api/jobs/cleanup', auth, (req, res) => {
    const olderThanDays = Math.max(parseInt((req.body && req.body.olderThanDays) || '7', 10), 0);
    const cutoff = Date.now() - olderThanDays * 86400000;
    const { rows } = store.list({ limit: 5000 });
    let deleted = 0;
    for (const j of rows) {
        if (new Date(j.createdAt).getTime() < cutoff) {
            store.remove(j.id);
            rmRecursive(path.join(SCREENSHOT_DIR, j.id));
            deleted++;
        }
    }
    res.json({ ok: true, deleted });
});

app.delete('/api/jobs', auth, (req, res) => {
    const { rows } = store.list({ limit: 5000 });
    for (const j of rows) {
        store.remove(j.id);
        rmRecursive(path.join(SCREENSHOT_DIR, j.id));
    }
    res.json({ ok: true, deleted: rows.length });
});

// ---------- Before/after comparison ----------

function fileUrl(jobId, filename) {
    return `${PUBLIC_BASE_URL}/files/${jobId}/${filename}`;
}

// Diff two existing jobs section-by-section (matched by section name) and store the result.
app.post('/compare', auth, (req, res) => {
    const { before, after, threshold } = req.body || {};
    const jb = store.get(before);
    const ja = store.get(after);
    if (!jb || !ja) return res.status(404).json({ error: 'job_not_found' });

    const thr = Math.min(Math.max(parseFloat(threshold), 0), 1) || 0.1;
    const compareId = 'cmp-' + crypto.randomBytes(8).toString('hex');
    const outDir = path.join(SCREENSHOT_DIR, compareId);
    fs.mkdirSync(outDir, { recursive: true });

    const afterBySection = new Map(
        (ja.files || []).filter((f) => f.filename).map((f) => [f.section || f.filename, f])
    );

    const results = [];
    let maxDiffPercent = 0;
    let changedCount = 0;

    for (const bf of (jb.files || []).filter((f) => f.filename)) {
        const section = bf.section || bf.filename;
        const af = afterBySection.get(section);
        if (!af) {
            results.push({ section, status: 'missing_in_after' });
            continue;
        }
        const pathBefore = path.join(SCREENSHOT_DIR, before, bf.filename);
        const pathAfter = path.join(SCREENSHOT_DIR, after, af.filename);
        if (!fs.existsSync(pathBefore) || !fs.existsSync(pathAfter)) {
            results.push({ section, status: 'file_missing' });
            continue;
        }
        try {
            const diffName = `${section}-diff.png`;
            const stat = compareFiles(pathBefore, pathAfter, path.join(outDir, diffName), { threshold: thr });
            const changed = stat.diffRatio > CHANGED_RATIO;
            if (changed) changedCount++;
            if (stat.diffPercent > maxDiffPercent) maxDiffPercent = stat.diffPercent;
            results.push({
                section,
                status: 'compared',
                changed,
                ...stat,
                beforeUrl: fileUrl(before, bf.filename),
                afterUrl: fileUrl(after, af.filename),
                diffUrl: fileUrl(compareId, diffName),
            });
        } catch (err) {
            results.push({ section, status: 'error', error: err.message });
        }
    }

    const record = {
        id: compareId,
        before,
        after,
        beforeUrl: jb.url,
        afterUrl: ja.url,
        createdAt: new Date().toISOString(),
        threshold: thr,
        comparedCount: results.filter((r) => r.status === 'compared').length,
        changedCount,
        maxDiffPercent,
        results,
    };
    comparisons.add(record);
    res.json(record);
});

app.get('/api/comparisons', auth, (req, res) => {
    const limitN = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const { total, rows } = comparisons.list({ limit: limitN, offset });
    res.json({ total, comparisons: rows });
});

app.get('/api/comparisons/:id', auth, (req, res) => {
    const c = comparisons.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json(c);
});

app.delete('/api/comparisons/:id', auth, (req, res) => {
    const id = req.params.id;
    const removed = comparisons.remove(id);
    rmRecursive(path.join(SCREENSHOT_DIR, id));
    res.json({ ok: true, removed });
});

const server = app.listen(PORT, () => {
    console.log(`screenshot-api on :${PORT}  dashboard: ${PUBLIC_BASE_URL}/dashboard/  (concurrency=${MAX_CONCURRENCY})`);
});

async function shutdown(signal) {
    console.log(`${signal} received, shutting down...`);
    server.close(() => {});
    await closeBrowser();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
