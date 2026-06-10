const fs = require('fs');
const path = require('path');

class JobStore {
    constructor(dir, filename = 'jobs.json') {
        this.dir = dir;
        this.file = path.join(dir, filename);
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(this.file)) {
            fs.writeFileSync(this.file, '[]');
        }
        this._cache = this._load();
    }

    _load() {
        try {
            return JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch {
            return [];
        }
    }

    _save() {
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this._cache, null, 2));
        fs.renameSync(tmp, this.file);
    }

    add(entry) {
        this._cache.unshift(entry);
        if (this._cache.length > 5000) this._cache.length = 5000;
        this._save();
    }

    update(id, patch) {
        const idx = this._cache.findIndex((j) => j.id === id);
        if (idx === -1) return null;
        this._cache[idx] = { ...this._cache[idx], ...patch };
        this._save();
        return this._cache[idx];
    }

    list({ limit = 100, offset = 0, status } = {}) {
        let rows = this._cache;
        if (status) rows = rows.filter((r) => r.status === status);
        return { total: rows.length, rows: rows.slice(offset, offset + limit) };
    }

    get(id) {
        return this._cache.find((j) => j.id === id) || null;
    }

    remove(id) {
        const before = this._cache.length;
        this._cache = this._cache.filter((j) => j.id !== id);
        if (this._cache.length !== before) {
            this._save();
            return true;
        }
        return false;
    }

    stats() {
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        const durations = [];
        let total = 0,
            today = 0,
            week = 0,
            failed = 0,
            totalBytes = 0;

        for (const j of this._cache) {
            total++;
            const created = new Date(j.createdAt).getTime();
            if (now - created < dayMs) today++;
            if (now - created < 7 * dayMs) week++;
            if (j.status === 'failed') failed++;
            if (typeof j.durationMs === 'number') durations.push(j.durationMs);
            if (typeof j.totalBytes === 'number') totalBytes += j.totalBytes;
        }

        const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
        return { total, today, week, failed, avgDurationMs: avg, totalBytes };
    }
}

module.exports = { JobStore };
