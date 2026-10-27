// End-to-end: .tgz extraction, single and concurrent, node-tar vs tar-codec.
const ROOT = __dirname
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const { performance } = require('perf_hooks')

const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')

const ITER = Number(process.argv[2] || 5)
const CORPUS = ROOT + '/corpus'
const WORK = ROOT + '/work'

const tarExtract = (buf, dest) => new Promise((resolve, reject) => {
  const p = tar.x({ cwd: dest, strict: true })
  p.on('close', resolve)
  p.on('error', reject)
  p.end(buf)
})

const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const fmt = ms => ms.toFixed(1)

const fresh = d => { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }) }

;(async () => {
  console.log('single archive, .tgz end to end (node-tar decompresses itself; codec gets gunzipSync output)')
  console.log('| corpus | node-tar x | gunzip only | gunzip+codec | codec total | speedup |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  const corpora = ['lodash', 'typescript', 'eslint', 'many-small']
  const gz = {}, raw = {}
  for (const c of corpora) {
    gz[c] = fs.readFileSync(path.join(CORPUS, c + '.tar.gz'))
    raw[c] = zlib.gunzipSync(gz[c])
  }
  for (const c of corpora) {
    const a = [], g = [], e = []
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
      const decompressed = zlib.gunzipSync(gz[c])
      const tg = performance.now() - t0
      t0 = performance.now()
      codec.extract(decompressed, dst2, true)
      const te = performance.now() - t0
      fs.rmSync(dst2, { recursive: true, force: true })

      if (i > 0) { a.push(ta); g.push(tg); e.push(te) }
    }
    const total = med(g) + med(e)
    console.log(`| ${c} | ${fmt(med(a))} ms | ${fmt(med(g))} ms | ${fmt(med(e))} ms | ${fmt(total)} ms | ${(med(a) / total).toFixed(2)}x |`)
  }

  // concurrency: 24 archives (8 each of three packages), all started at once
  console.log('')
  console.log('24 archives, all started at once, 8 dirs each of lodash/typescript/eslint')
  const jobs = []
  for (const c of ['lodash', 'typescript', 'eslint']) {
    for (let i = 0; i < 8; i++) jobs.push({ c, gz: gz[c], raw: raw[c] })
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
  const tarRuns = [], codecRuns = []
  for (let i = 0; i < ITER + 1; i++) {
    const a = await runSet((j, d) => tarExtract(j.gz, d))
    const b = await runSet(async (j, d) => { await codec.extractAsync(j.raw, d, true) })
    if (i > 0) { tarRuns.push(a); codecRuns.push(b) }
  }
  console.log(`node-tar: ${fmt(med(tarRuns))} ms   tar-codec (async, no gunzip): ${fmt(med(codecRuns))} ms   speedup ${(med(tarRuns) / med(codecRuns)).toFixed(2)}x`)
})()
