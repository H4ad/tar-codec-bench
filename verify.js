// Verify both extractors produce identical trees (path, size, sha256, exec bit).
const ROOT = __dirname
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')

const walk = (root, rel = '', acc = new Map()) => {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) { acc.set(r + '/', 'dir'); walk(root, r, acc) } else if (ent.isSymbolicLink()) acc.set(r, 'link:' + fs.readlinkSync(path.join(root, r)))
    else {
      const st = fs.statSync(path.join(root, r))
      const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, r))).digest('hex').slice(0, 12)
      acc.set(r, `${st.size}:${(st.mode & 0o111) ? 'x' : '-'}:${h}`)
    }
  }
  return acc
}

;(async () => {
  for (const name of process.argv.slice(2)) {
    const buf = fs.readFileSync(`${ROOT}/corpus/${name}.tar`)
    const a = `${ROOT}/work/v-tar-${name}`
    const b = `${ROOT}/work/v-codec-${name}`
    for (const d of [a, b]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }) }
    await new Promise((res, rej) => {
      const p = tar.x({ cwd: a, strict: true }); p.on('close', res); p.on('error', rej); p.end(buf)
    })
    codec.extract(buf, b, true)
    const ma = walk(a); const mb = walk(b)
    let diff = 0
    for (const [k, v] of ma) if (mb.get(k) !== v) { if (diff++ < 5) console.log(`  diff ${k}: tar=${v} codec=${mb.get(k)}`) }
    for (const k of mb.keys()) if (!ma.has(k)) { if (diff++ < 5) console.log(`  extra in codec: ${k}`) }
    console.log(`${name}: tar ${ma.size} entries, codec ${mb.size} entries, diffs=${diff}`)
    for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true })
  }
})()
