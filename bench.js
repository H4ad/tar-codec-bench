// Benchmark: node-tar vs tar-codec (astral) on parse and extract.
// usage: node bench.js [iterations]
const ROOT = __dirname
const fs = require('fs')
const path = require('path')
const { performance } = require('perf_hooks')

const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')

const ITER = Number(process.argv[2] || 7)
const CORPUS = ROOT + '/corpus'
const WORK = ROOT + '/work'

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

// ---------- tar-codec ----------
const codecExtract = async (buf, dest) => {
  codec.extract(buf, dest, true)
}
const codecList = async (buf) => codec.list(buf)

const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}
const fmt = (ms) => (ms < 10 ? ms.toFixed(2) : ms.toFixed(1))

const results = []

const timeIt = async (fn, buf, dest) => {
  if (dest) {
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
  }
  const t0 = performance.now()
  await fn(buf, dest)
  return performance.now() - t0
}

;(async () => {
  for (const name of corpora) {
    const buf = fs.readFileSync(path.join(CORPUS, name + '.tar'))
    const destTar = path.join(WORK, 'x-tar-' + name)
    const destCodec = path.join(WORK, 'x-codec-' + name)

    const row = {
      name,
      mb: +(fileBytes[name] / 1024 / 1024).toFixed(1),
      entries: null,
      tarList: [], codecList: [], tarExtract: [], codecExtract: [],
    }

    // correctness cross-check (entry count + total size)
    const tl = await tarList(buf)
    const cl = await codecList(buf)
    row.entries = tl.length
    const tsum = tl.reduce((a, e) => a + e[1], 0)
    const csum = cl.reduce((a, e) => a + e.size, 0)
    if (tl.length !== cl.length || tsum !== csum) {
      console.log(`MISMATCH ${name}: node-tar ${tl.length}/${tsum} codec ${cl.length}/${csum}`)
    }

    // warmup
    await timeIt(tarList, buf)
    await timeIt(codecList, buf)
    await timeIt(tarExtract, buf, destTar)
    await timeIt(codecExtract, buf, destCodec)

    for (let i = 0; i < ITER; i++) {
      // alternate order to spread cache/thermal effects
      if (i % 2 === 0) {
        row.tarList.push(await timeIt(tarList, buf))
        row.codecList.push(await timeIt(codecList, buf))
        row.tarExtract.push(await timeIt(tarExtract, buf, destTar))
        row.codecExtract.push(await timeIt(codecExtract, buf, destCodec))
      } else {
        row.codecList.push(await timeIt(codecList, buf))
        row.tarList.push(await timeIt(tarList, buf))
        row.codecExtract.push(await timeIt(codecExtract, buf, destCodec))
        row.tarExtract.push(await timeIt(tarExtract, buf, destTar))
      }
    }
    results.push(row)
    fs.rmSync(destTar, { recursive: true, force: true })
    fs.rmSync(destCodec, { recursive: true, force: true })
  }

  const pad = (s, n) => String(s).padStart(n)
  console.log('')
  console.log('| corpus | size | entries | parse node-tar | parse tar-codec | speedup | extract node-tar | extract tar-codec | speedup |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const pl = median(r.tarList), pc = median(r.codecList)
    const el = median(r.tarExtract), ec = median(r.codecExtract)
    console.log(
      `| ${r.name} | ${r.mb} MB | ${r.entries} | ${fmt(pl)} ms | ${fmt(pc)} ms | ${(pl / pc).toFixed(2)}x | ` +
      `${fmt(el)} ms | ${fmt(ec)} ms | ${(el / ec).toFixed(2)}x |`
    )
  }
  console.log('')
  for (const r of results) {
    console.log(`raw ${r.name} parse   node-tar=${r.tarList.map(fmt).join(',')}  codec=${r.codecList.map(fmt).join(',')}`)
    console.log(`raw ${r.name} extract node-tar=${r.tarExtract.map(fmt).join(',')}  codec=${r.codecExtract.map(fmt).join(',')}`)
  }
})()
