// Isolate node-tar's gzip path cost.
const ROOT = __dirname
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const { performance } = require('perf_hooks')
const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')

const C = ROOT + '/corpus'
const W = ROOT + '/work'
const fresh = d => { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }) }
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

const x = (buf, dest) => new Promise((res, rej) => {
  const p = tar.x({ cwd: dest, strict: true }); p.on('close', res); p.on('error', rej); p.end(buf)
})
const xFile = (file, dest) => tar.x({ cwd: dest, strict: true, file })

;(async () => {
  const raw = fs.readFileSync(C + '/lodash.tar')
  const gz = fs.readFileSync(C + '/lodash.tar.gz')
  const gzFile = C + '/lodash.tar.gz'
  const plainFile = C + '/lodash.tar'
  const runs = { rawBuf: [], gzBuf: [], gzFile: [], rawFile: [], gunzipPlusRaw: [], codec: [] }
  for (let i = 0; i < 7; i++) {
    let d = W + '/i1'; fresh(d); let t = performance.now(); await x(raw, d); runs.rawBuf.push(performance.now() - t)
    d = W + '/i2'; fresh(d); t = performance.now(); await x(gz, d); runs.gzBuf.push(performance.now() - t)
    d = W + '/i3'; fresh(d); t = performance.now(); await xFile(gzFile, d); runs.gzFile.push(performance.now() - t)
    d = W + '/i4'; fresh(d); t = performance.now(); await xFile(plainFile, d); runs.rawFile.push(performance.now() - t)
    d = W + '/i5'; fresh(d); t = performance.now(); const u = zlib.gunzipSync(gz); await x(u, d); runs.gunzipPlusRaw.push(performance.now() - t)
    d = W + '/i6'; fresh(d); t = performance.now(); codec.extract(raw, d, true); runs.codec.push(performance.now() - t)
  }
  for (const [k, v] of Object.entries(runs)) console.log(k.padEnd(14), med(v).toFixed(1) + ' ms')
  fs.rmSync(W, { recursive: true, force: true })
})()
