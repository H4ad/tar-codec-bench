// Peak RSS for one extraction arm. Prints "<maxRSS_kb> <rss_delta_kb>".
// usage: node mem.js <arm> <corpus> <iterations> [parallel]
const ROOT = __dirname
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')

const [arm, corpus, itersArg, parArg] = process.argv.slice(2)
const ITERS = Number(itersArg || 5)
const PAR = Number(parArg || 1)
const file = `${ROOT}/corpus/${corpus}${corpus.endsWith('.tgz') ? '' : '.tar'}`
const buf = fs.readFileSync(file)
const W = ROOT + '/work/mem'

const fresh = d => { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }) }
const rss0 = process.memoryUsage().rss

const tarExtract = (b, dest) => new Promise((res, rej) => {
  const p = tar.x({ cwd: dest, strict: true, strip: corpus.endsWith('.tgz') ? 1 : 0 })
  p.on('close', res)
  p.on('error', rej)
  p.end(b)
})

const one = async (i) => {
  const d = path.join(W, String(i))
  fs.mkdirSync(d, { recursive: true })
  if (arm === 'tar') await tarExtract(buf, d)
  else if (arm === 'codec') codec.extract(corpus.endsWith('.tgz') ? zlib.gunzipSync(buf) : buf, d, true)
  else if (arm === 'codec-gz') await codec.extractGzAsync(buf, d, true)
  else if (arm === 'codec-async') await codec.extractAsync(corpus.endsWith('.tgz') ? zlib.gunzipSync(buf) : buf, d, true)
  else if (arm === 'baseline') { /* just hold the buffer */ }
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
