// Mode and mtime restore, shared by bench.js and verify.js.
//
// tar-codec 0.0.15 exposes neither mode nor mtime, so these values come from
// node-tar's listing and are applied in JS. Any future wrapper that exposes
// them natively would do the same work in Rust, cheaper.
const fs = require('fs')
const path = require('path')
const tar = require('tar')

// [path, kind, mode, mtime] for every file and directory in the archive
const read = (buf) => new Promise((resolve, reject) => {
  const out = []
  const p = tar.t({
    strict: true,
    onentry (entry) {
      if (entry.type === 'File' || entry.type === 'OldFile' || entry.type === 'Directory') {
        out.push([entry.path, entry.type, entry.mode & 0o777, entry.mtime ? new Date(entry.mtime) : null])
      }
      entry.resume()
    },
  })
  p.on('close', () => resolve(out))
  p.on('error', reject)
  p.end(buf)
})

// reverse order: node-tar fixes up directory mtimes after the files land
const apply = (dest, meta) => {
  for (let i = meta.length - 1; i >= 0; i--) {
    const [p, kind, mode, mtime] = meta[i]
    const abs = path.join(dest, p)
    try {
      fs.chmodSync(abs, mode)
      if (mtime) fs.utimesSync(abs, mtime, mtime)
    } catch {}
  }
}

const compare = (a, b, meta, limit = 8) => {
  const diffs = []
  for (const [p, kind, mode, mtime] of meta) {
    const sa = fs.lstatSync(path.join(a, p))
    const sb = fs.lstatSync(path.join(b, p))
    const ma = sa.mode & 0o777
    const mb = sb.mode & 0o777
    const ta = sa.mtimeMs
    const tb = sb.mtimeMs
    const mtimeOff = mtime == null ? 0 : Math.abs(ta - tb)
    if (ma !== mb || mtimeOff > 100) {
      diffs.push({ path: p, tarMode: ma.toString(8), codecMode: mb.toString(8), tarMtime: ta, codecMtime: tb })
    }
  }
  return { entries: meta.length, diffs: diffs.length, examples: diffs.slice(0, limit) }
}

module.exports = { read, apply, compare }
