// One tree signature, used by bench.js, bench-install.js and verify.js, so a
// benchmark cannot report a time for an extraction it did not check.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const walk = (root, rel = '', acc = new Map()) => {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      acc.set(r + '/', 'dir')
      walk(root, r, acc)
    } else if (ent.isSymbolicLink()) {
      acc.set(r, 'link:' + fs.readlinkSync(path.join(root, r)))
    } else {
      const st = fs.statSync(path.join(root, r))
      const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, r))).digest('hex').slice(0, 12)
      acc.set(r, `${st.size}:${(st.mode & 0o111) ? 'x' : '-'}:${h}`)
    }
  }
  return acc
}

// Compare two extracted trees. Returns every difference, capped for output.
const compare = (a, b, limit = 10) => {
  const ma = walk(a)
  const mb = walk(b)
  const diffs = []
  for (const [k, v] of ma) if (mb.get(k) !== v) diffs.push({ path: k, tar: v, codec: mb.get(k) })
  for (const k of mb.keys()) if (!ma.has(k)) diffs.push({ path: k, tar: null, codec: mb.get(k) })
  return { entriesTar: ma.size, entriesCodec: mb.size, diffs: diffs.length, examples: diffs.slice(0, limit) }
}

const assertSame = (a, b, label) => {
  const r = compare(a, b)
  if (r.diffs) {
    const first = r.examples.map(d => `  ${d.path}: tar=${d.tar} codec=${d.codec}`).join('\n')
    throw new Error(`${label}: ${r.diffs} differences\n${first}`)
  }
  return r
}

module.exports = { walk, compare, assertSame }
