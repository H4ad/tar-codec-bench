// Benchmark: node-tar vs tar-codec on parse and extract.
// usage: node bench.js [iterations]
//
// Four extraction arms, so the compare separates parser speed from dropped work:
//   tar                   node-tar defaults (modes and mtimes restored)
//   tarNoMeta             node-tar with noChmod + noMtime
//   codec                 tar-codec extract_in (modes normalized, no mtime restore)
//   codecMeta             tar-codec followed by a JS pass that restores the modes
//                         and mtimes node-tar would have restored. This is an
//                         upper bound on the codec side: tar-codec 0.0.15 does
//                         not expose mode or mtime at all, so the pass has to
//                         read them from node-tar's listing and apply them in JS.
const ROOT = __dirname
const fs = require('fs')
const path = require('path')
const { performance } = require('perf_hooks')

const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')
const { WORK, fresh } = require('./lib/work')
const tree = require('./lib/tree')
const metaLib = require('./lib/meta')
const results = require('./lib/results')

const ITER = Number(process.argv[2] || 7)
const CORPUS = ROOT + '/corpus'

const corpora = ['lodash', 'typescript', 'eslint', 'many-small', 'few-large']

const fileBytes = {}
for (const c of corpora) fileBytes[c] = fs.statSync(path.join(CORPUS, c + '.tar')).size

// ---------- node-tar ----------
const tarExtract = (buf, dest) => new Promise((resolve, reject) => {
  const p = tar.x({ cwd: dest, strict: true })
  p.on('close', resolve)
  p.on('error', reject)
  p.end(buf)
})

const tarExtractNoMeta = (buf, dest) => new Promise((resolve, reject) => {
  const p = tar.x({ cwd: dest, strict: true, noChmod: true, noMtime: true })
  p.on('close', resolve)
  p.on('error', reject)
  p.end(buf)
})

const tarList = (buf) => new Promise((resolve, reject) => {
  const out = []
  const p = tar.t({
    strict: true,
    onentry (entry) {
      out.push([entry.path, entry.size, entry.mode])
      entry.resume()
    },
  })
  p.on('close', () => resolve(out))
  p.on('error', reject)
  p.end(buf)
})

// mode + mtime per entry, read once with node-tar, used by the codecMeta arm
let currentMeta = []
const codecExtract = async (buf, dest) => {
  codec.extract(buf, dest, true)
}
const codecExtractMeta = async (buf, dest) => {
  codec.extract(buf, dest, true)
  metaLib.apply(dest, currentMeta)
}
const codecList = async (buf) => codec.list(buf)

const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}
const fmt = (ms) => (ms < 10 ? ms.toFixed(2) : ms.toFixed(1))

const timeIt = async (fn, buf, dest) => {
  if (dest) fresh(dest)
  const t0 = performance.now()
  await fn(buf, dest)
  return performance.now() - t0
}

const arms = [
  { key: 'parseTar', fn: tarList },
  { key: 'parseCodec', fn: codecList },
  { key: 'extractTar', fn: tarExtract, dest: true },
  { key: 'extractCodec', fn: codecExtract, dest: true },
  { key: 'extractTarNoMeta', fn: tarExtractNoMeta, dest: true },
  { key: 'extractCodecMeta', fn: codecExtractMeta, dest: true },
]

;(async () => {
  const rows = []
  for (const name of corpora) {
    const buf = fs.readFileSync(path.join(CORPUS, name + '.tar'))
    currentMeta = await metaLib.read(buf)
    const dirs = {}
    for (const a of arms) if (a.dest) dirs[a.key] = path.join(WORK, a.key + '-' + name)

    const row = {
      name,
      bytes: fileBytes[name],
      mb: +(fileBytes[name] / 1024 / 1024).toFixed(1),
      entries: null,
      arms: Object.fromEntries(arms.map(a => [a.key, []])),
      verify: null,
    }

    // entry-count cross-check
    const tl = await tarList(buf)
    const cl = await codecList(buf)
    row.entries = tl.length
    const tsum = tl.reduce((a, e) => a + e[1], 0)
    const csum = cl.reduce((a, e) => a + e.size, 0)
    if (tl.length !== cl.length || tsum !== csum) {
      console.log(`MISMATCH ${name}: node-tar ${tl.length}/${tsum} codec ${cl.length}/${csum}`)
    }

    // full tree check outside the timed loop: paths, sizes, exec bit and sha256
    fresh(dirs.extractTar)
    fresh(dirs.extractCodec)
    await tarExtract(buf, dirs.extractTar)
    await codecExtract(buf, dirs.extractCodec)
    row.verify = tree.compare(dirs.extractTar, dirs.extractCodec)
    if (row.verify.diffs) {
      console.log(`TREE MISMATCH ${name}: ${row.verify.diffs} differences`)
      for (const d of row.verify.examples) console.log(`  ${d.path}: tar=${d.tar} codec=${d.codec}`)
    }
    fs.rmSync(dirs.extractTar, { recursive: true, force: true })
    fs.rmSync(dirs.extractCodec, { recursive: true, force: true })

    // warmup
    for (const a of arms) await timeIt(a.fn, buf, a.dest ? dirs[a.key] : undefined)

    for (let i = 0; i < ITER; i++) {
      const order = i % 2 === 0 ? arms : [...arms].reverse()
      for (const a of order) {
        const t = await timeIt(a.fn, buf, a.dest ? dirs[a.key] : undefined)
        row.arms[a.key].push(t)
      }
    }
    for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true })
    rows.push(row)
  }

  results.write('raw', { iterations: ITER, corpora: rows })

  const pad = (s, n) => String(s).padStart(n)
  console.log('')
  console.log('| corpus | entries | parse node-tar | parse tar-codec | extract node-tar | extract tar-codec | ratio | tar noChmod/noMtime | codec + mode/mtime | matched ratio |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of rows) {
    const m = (k) => median(r.arms[k])
    console.log(
      `| ${r.name} | ${r.entries} | ${fmt(m('parseTar'))} ms | ${fmt(m('parseCodec'))} ms | ` +
      `${fmt(m('extractTar'))} ms | ${fmt(m('extractCodec'))} ms | ${(m('extractTar') / m('extractCodec')).toFixed(2)}x | ` +
      `${fmt(m('extractTarNoMeta'))} ms | ${fmt(m('extractCodecMeta'))} ms | ${(m('extractTarNoMeta') / m('extractCodecMeta')).toFixed(2)}x |`
    )
  }
  console.log('')
  for (const r of rows) {
    for (const k of Object.keys(r.arms)) {
      console.log(`raw ${r.name} ${k.padEnd(16)} ${r.arms[k].map(fmt).join(',')}`)
    }
  }
})()
