// End-to-end: .tgz extraction, single and concurrent, node-tar vs tar-codec.
// Every arm that touches a .tgz inflates it inside its own timed region, so the
// concurrency result includes gunzip on both sides.
const ROOT = __dirname
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const { performance } = require('perf_hooks')

const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')
const { WORK, fresh } = require('./lib/work')
const tree = require('./lib/tree')
const results = require('./lib/results')

const ITER = Number(process.argv[2] || 5)
const CORPUS = ROOT + '/corpus'

const tarExtract = (buf, dest) => new Promise((resolve, reject) => {
  const p = tar.x({ cwd: dest, strict: true })
  p.on('close', resolve)
  p.on('error', reject)
  p.end(buf)
})

const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const fmt = ms => ms.toFixed(1)

;(async () => {
  console.log('single archive, .tgz end to end (each arm inflates its own input)')
  console.log('| corpus | node-tar x | gunzip only | gunzip+codec | codec total | speedup |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  const corpora = ['lodash', 'typescript', 'eslint', 'many-small']
  const gz = {}
  const rows = []
  for (const c of corpora) {
    const file = path.join(CORPUS, c + '.tar.gz')
    if (!fs.existsSync(file)) {
      throw new Error(`missing ${file}; run \`npm run corpus\` (gen.js now writes .tar.gz for the synthetic corpora)`)
    }
    gz[c] = fs.readFileSync(file)
  }
  for (const c of corpora) {
    // correctness once, outside the timed loop
    const a = path.join(WORK, 'e2e-v-tar-' + c)
    const b = path.join(WORK, 'e2e-v-codec-' + c)
    fresh(a)
    fresh(b)
    await tarExtract(gz[c], a)
    const decompressed = zlib.gunzipSync(gz[c])
    codec.extract(decompressed, b, true)
    const verify = tree.compare(a, b)
    fs.rmSync(a, { recursive: true, force: true })
    fs.rmSync(b, { recursive: true, force: true })
    if (verify.diffs) console.log(`TREE MISMATCH ${c}: ${verify.diffs} differences`)

    const tarTimes = [], gzTimes = [], codecTimes = [], totals = []
    for (let i = 0; i < ITER + 1; i++) {
      const dst = path.join(WORK, 'e2e-tar-' + c)
      fresh(dst)
      let t0 = performance.now()
      await tarExtract(gz[c], dst)
      const ta = performance.now() - t0
      fs.rmSync(dst, { recursive: true, force: true })

      const dst2 = path.join(WORK, 'e2e-codec-' + c)
      fresh(dst2)
      t0 = performance.now()
      const raw = zlib.gunzipSync(gz[c])
      const tg = performance.now() - t0
      t0 = performance.now()
      codec.extract(raw, dst2, true)
      const te = performance.now() - t0
      fs.rmSync(dst2, { recursive: true, force: true })

      if (i > 0) {
        tarTimes.push(ta)
        gzTimes.push(tg)
        codecTimes.push(te)
        totals.push(tg + te)
      }
    }
    const row = {
      name: c,
      verify,
      tar: tarTimes,
      gunzip: gzTimes,
      codec: codecTimes,
      totals,
    }
    rows.push(row)
    console.log(`| ${c} | ${fmt(med(tarTimes))} ms | ${fmt(med(gzTimes))} ms | ${fmt(med(codecTimes))} ms | ${fmt(med(totals))} ms | ${(med(tarTimes) / med(totals)).toFixed(2)}x |`)
  }

  // concurrency: 24 archives (8 each of three packages), all started at once
  console.log('')
  console.log('24 archives, all started at once, 8 dirs each of lodash/typescript/eslint')
  const jobs = []
  for (const c of ['lodash', 'typescript', 'eslint']) {
    for (let i = 0; i < 8; i++) jobs.push({ c, gz: gz[c], raw: zlib.gunzipSync(gz[c]) })
  }
  const runSet = async (fn) => {
    const base = path.join(WORK, 'par-' + Math.random().toString(36).slice(2))
    const t0 = performance.now()
    await Promise.all(jobs.map((j, i) => {
      const d = path.join(base, String(i))
      fresh(d)
      return fn(j, d)
    }))
    const t = performance.now() - t0
    fs.rmSync(base, { recursive: true, force: true })
    return t
  }
  const arms = { tar: [], asyncRaw: [], asyncGz: [] }
  for (let i = 0; i < ITER + 1; i++) {
    const a = await runSet((j, d) => tarExtract(j.gz, d))
    // raw input already inflated: kept only to show what skipping inflate buys
    const b = await runSet(async (j, d) => { await codec.extractAsync(j.raw, d, true) })
    const g = await runSet(async (j, d) => { await codec.extractGzAsync(j.gz, d, true) })
    if (i > 0) {
      arms.tar.push(a)
      arms.asyncRaw.push(b)
      arms.asyncGz.push(g)
    }
  }
  console.log(`node-tar: ${fmt(med(arms.tar))} ms`)
  console.log(`tar-codec async, pre-gunzipped buffer (inflate excluded): ${fmt(med(arms.asyncRaw))} ms, ${(med(arms.tar) / med(arms.asyncRaw)).toFixed(2)}x`)
  console.log(`tar-codec async, gzip inside the addon (inflate included): ${fmt(med(arms.asyncGz))} ms, ${(med(arms.tar) / med(arms.asyncGz)).toFixed(2)}x`)

  results.write('tgz', {
    iterations: ITER,
    corpora: rows,
    concurrent: { jobs: jobs.length, arms, median: { tar: med(arms.tar), asyncRaw: med(arms.asyncRaw), asyncGz: med(arms.asyncGz) } },
  })
})()
