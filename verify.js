// Verify both extractors produce identical trees (path, size, sha256, exec bit),
// and that the codec-plus-metadata arm restores the same modes and mtimes
// node-tar does. This is the same content check bench.js runs before timing.
const ROOT = __dirname
const fs = require('fs')
const path = require('path')
const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')
const { WORK, fresh } = require('./lib/work')
const tree = require('./lib/tree')
const metaLib = require('./lib/meta')
const results = require('./lib/results')

;(async () => {
  const corpora = process.argv.slice(2)
  const rows = []
  for (const name of corpora) {
    const buf = fs.readFileSync(`${ROOT}/corpus/${name}.tar`)
    const meta = await metaLib.read(buf)
    const a = path.join(WORK, 'v-tar-' + name)
    const b = path.join(WORK, 'v-codec-' + name)
    const c = path.join(WORK, 'v-codec-meta-' + name)
    for (const d of [a, b, c]) fresh(d)
    await new Promise((res, rej) => {
      const p = tar.x({ cwd: a, strict: true }); p.on('close', res); p.on('error', rej); p.end(buf)
    })
    codec.extract(buf, b, true)
    codec.extract(buf, c, true)
    metaLib.apply(c, meta)
    const cmp = tree.compare(a, b)
    const metaCmp = metaLib.compare(a, c, meta)
    rows.push({ name, ...cmp, metadata: metaCmp })
    for (const d of cmp.examples.slice(0, 5)) console.log(`  diff ${d.path}: tar=${d.tar} codec=${d.codec}`)
    for (const d of metaCmp.examples.slice(0, 5)) console.log(`  meta ${d.path}: tar=${d.tarMode}/${d.tarMtime} codec=${d.codecMode}/${d.codecMtime}`)
    console.log(`${name}: tar ${cmp.entriesTar} entries, codec ${cmp.entriesCodec} entries, content diffs=${cmp.diffs}, metadata diffs=${metaCmp.diffs}`)
    for (const d of [a, b, c]) fs.rmSync(d, { recursive: true, force: true })
  }
  const bad = rows.filter(r => r.diffs || r.metadata.diffs)
  results.write('verify', { corpora: rows, ok: bad.length === 0 })
  if (bad.length) process.exitCode = 1
})()
