const fs = require('fs');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

function readPng(p) {
    return PNG.sync.read(fs.readFileSync(p));
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

// Compare two PNG files, write a highlighted diff image to outPath, and return stats.
// `threshold` is pixelmatch's per-pixel colour sensitivity (0 strict – 1 loose).
function compareFiles(pathA, pathB, outPath, { threshold = 0.1 } = {}) {
    const a = readPng(pathA);
    const b = readPng(pathB);
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
    fs.writeFileSync(outPath, PNG.sync.write(diff));

    const totalPixels = width * height;
    return {
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
}

module.exports = { compareFiles };
