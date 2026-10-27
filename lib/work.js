// Scratch root for every benchmark. Defaults to the OS temp dir, which is
// tmpfs on Linux, and can be overridden with TAR_BENCH_WORK to measure a real
// disk instead. Keeping it out of the repo means `npm run bench` never
// silently measures btrfs.
const fs = require('fs')
const os = require('os')
const path = require('path')

const WORK = process.env.TAR_BENCH_WORK || path.join(os.tmpdir(), 'tar-codec-bench-work')
fs.mkdirSync(WORK, { recursive: true })

const fresh = (d) => {
  fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(d, { recursive: true })
}

module.exports = { WORK, fresh }
