// Peak RSS for one extraction arm. Prints "<maxRSS_kb> <rss_delta_kb> <rss0_kb>".
// usage: node mem.js <arm> <corpus> <iterations> [parallel]
//
// maxRSS is the process peak. The delta is the RSS left after the extraction
// dirs are removed, which is the retained cost, not the peak. mem-driver.js
// records both because the page charts peak over idle.
const ROOT = __dirname
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')
const { WORK, fresh } = require('./lib/work')

const [arm, corpus, itersArg, parArg] = process.argv.slice(2)
const ITERS = Number(itersArg || 5)
const PAR = Number(parArg || 1)
const isGz = corpus.endsWith('.tgz')
const file = path.join(ROOT, 'corpus', corpus + (isGz ? '' : '.tar'))
const buf = fs.readFileSync(file)
const W = path.join(WORK, 'mem')

const rss0 = process.memoryUsage().rss

const tarExtract = (b, dest) => new Promise((res, rej) => {
  const p = tar.x({ cwd: dest, strict: true, strip: isGz ? 1 : 0 })
  p.on('close', res)
  p.on('error', rej)
  p.end(b)
})

const one = async (i) => {
  const d = path.join(W, String(i))
  fs.mkdirSync(d, { recursive: true })
  if (arm === 'tar') await tarExtract(buf, d)
  else if (arm === 'codec') codec.extract(isGz ? zlib.gunzipSync(buf) : buf, d, true)
  else if (arm === 'codec-async') await codec.extractAsync(isGz ? zlib.gunzipSync(buf) : buf, d, true)
  else if (arm === 'codec-gz') codec.extractGz(buf, d, true)
  else if (arm === 'codec-gz-async') await codec.extractGzAsync(buf, d, true)
  else if (arm === 'baseline') { /* just hold the buffer */ }
  else throw new Error(`unknown arm ${arm}`)
  fs.rmSync(d, { recursive: true, force: true })
}

;(async () => {
  fresh(W)
  for (let i = 0; i < PAR; i++) fs.mkdirSync(path.join(W, String(i)), { recursive: true })
  for (let i = 0; i < ITERS; i++) {
    if (PAR === 1) await one(i % 1)
    else await Promise.all(Array.from({ length: PAR }, (_, j) => one(j)))
  }
  fs.rmSync(W, { recursive: true, force: true })
  const ru = process.resourceUsage()
  const peak = ru.maxRSS
  const now = process.memoryUsage().rss
  console.log(peak, Math.round((now - rss0) / 1024), Math.round(rss0 / 1024))
})()
