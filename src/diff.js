const fs = require('fs');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

function readPng(p) {
    return PNG.sync.read(fs.readFileSync(p));
}

function readPngBuffer(buf) {
    return PNG.sync.read(buf);
}

// Group the changed pixels in a pixelmatch diff into rectangular "regions" the
// plugin can draw highlight boxes around. We work in horizontal bands: scan the
// diff row by row counting changed pixels (diffColor red), then merge runs of
// changed rows that sit within `mergeGapPx` of each other into one band, and
// for each band record the min/max changed column so the box hugs the content.
//
// Coordinates are returned in ABSOLUTE pixels of the common (padded) image.
// Because both captures share the same width and are top-left aligned, an
// absolute Y maps onto each original pane directly — the plugin converts it to a
// per-pane percentage using that pane's own height (so boxes line up even when
// the two captures have different heights).
function extractRegions(diff, width, height, opts = {}) {
    const {
        minRowRatio = 0.002, // a row must have >0.2% changed px to count as "changed"
        mergeGapPx = 24,     // merge changed bands separated by < this many clean rows
        minBandPx = 6,       // ignore bands shorter than this (single-line antialias noise)
    } = opts;

    const minChangedInRow = Math.max(1, Math.floor(width * minRowRatio));
    const data = diff.data;

    // For each row: how many changed pixels, and the changed-column extent.
    const rows = new Array(height);
    for (let y = 0; y < height; y++) {
        let count = 0;
        let minX = width;
        let maxX = 0;
        const rowStart = y * width * 4;
        for (let x = 0; x < width; x++) {
            const i = rowStart + x * 4;
            // pixelmatch marks diffs in red; alpha stays 255. A pixel is
            // "changed" when the red channel is high and green/blue are low.
            if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80) {
                count++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
            }
        }
        rows[y] = count >= minChangedInRow ? { count, minX, maxX } : null;
    }

    const regions = [];
    let cur = null;
    let gap = 0;
    for (let y = 0; y < height; y++) {
        if (rows[y]) {
            if (!cur) {
                cur = { top: y, bottom: y, left: rows[y].minX, right: rows[y].maxX, changed: rows[y].count };
            } else {
                cur.bottom = y;
                cur.left = Math.min(cur.left, rows[y].minX);
                cur.right = Math.max(cur.right, rows[y].maxX);
                cur.changed += rows[y].count;
            }
            gap = 0;
        } else if (cur) {
            gap++;
            if (gap > mergeGapPx) {
                regions.push(cur);
                cur = null;
            }
        }
    }
    if (cur) regions.push(cur);

    return regions
        .filter((r) => r.bottom - r.top + 1 >= minBandPx)
        .map((r) => ({
            top: r.top,
            left: r.left,
            width: Math.max(1, r.right - r.left + 1),
            height: r.bottom - r.top + 1,
            changedPixels: r.changed,
        }));
}

// Copy `src` onto a fresh white-background canvas of the given size, top-left aligned.
// Before/after full-page shots often differ in height; padding to a common size lets us
// diff them anyway, with the size change itself surfaced as changed pixels.
function padTo(src, width, height) {
    if (src.width === width && src.height === height) return src;
    const out = new PNG({ width, height });
    out.data.fill(0xff); // opaque white
    PNG.bitblt(src, out, 0, 0, src.width, src.height, 0, 0);
    return out;
}

// Core comparison over two decoded PNGs. Pads both to a common size, runs
// pixelmatch at full resolution, writes a red-highlighted diff image to outPath,
// and returns stats + changed regions. `threshold` is pixelmatch's per-pixel
// colour sensitivity (0 strict – 1 loose). `withRegions` toggles band extraction.
function comparePngs(a, b, outPath, { threshold = 0.1, withRegions = true } = {}) {
    const width = Math.max(a.width, b.width);
    const height = Math.max(a.height, b.height);
    const pa = padTo(a, width, height);
    const pb = padTo(b, width, height);

    const diff = new PNG({ width, height });
    const diffPixels = pixelmatch(pa.data, pb.data, diff.data, width, height, {
        threshold,
        includeAA: false,
        alpha: 0.4,
        diffColor: [255, 0, 0],
    });
    if (outPath) {
        fs.writeFileSync(outPath, PNG.sync.write(diff));
    }

    const totalPixels = width * height;
    const stat = {
        width,
        height,
        diffPixels,
        totalPixels,
        diffRatio: totalPixels ? diffPixels / totalPixels : 0,
        diffPercent: totalPixels ? +((diffPixels / totalPixels) * 100).toFixed(3) : 0,
        sizeMismatch: a.width !== b.width || a.height !== b.height,
        dimsBefore: { width: a.width, height: a.height },
        dimsAfter: { width: b.width, height: b.height },
    };
    if (withRegions) {
        stat.regions = extractRegions(diff, width, height);
    }
    return stat;
}

// Compare two PNG files on disk.
function compareFiles(pathA, pathB, outPath, opts = {}) {
    return comparePngs(readPng(pathA), readPng(pathB), outPath, opts);
}

// Compare two in-memory PNG buffers (used by the /diff upload endpoint).
function compareBuffers(bufA, bufB, outPath, opts = {}) {
    return comparePngs(readPngBuffer(bufA), readPngBuffer(bufB), outPath, opts);
}

module.exports = { compareFiles, compareBuffers, extractRegions };
