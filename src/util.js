const fs = require('fs');
const path = require('path');

function dirSize(dir) {
    let bytes = 0;
    let count = 0;
    if (!fs.existsSync(dir)) return { bytes: 0, count: 0 };
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
            const sub = dirSize(p);
            bytes += sub.bytes;
            count += sub.count;
        } else {
            bytes += stat.size;
            count++;
        }
    }
    return { bytes, count };
}

function rmRecursive(target) {
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
}

module.exports = { dirSize, rmRecursive };
