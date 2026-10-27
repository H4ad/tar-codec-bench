// Is the node-tar extraction cost IO or JS? Compare against a raw fs loop floor,
// and check whether repeated runs speed up with concurrency.
const ROOT = __dirname
const fs = require('fs')
const path = require('path')
const { performance } = require('perf_hooks')
const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')
const { WORK, fresh } = require('./lib/work')
const results = require('./lib/results')

const W = path.join(WORK, 'floor')
const buf = fs.readFileSync(ROOT + '/corpus/lodash.tar')
const entries = codec.list(buf)
const files = entries.filter(e => e.kind === 'file')
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

const x = (b, d) => new Promise((res, rej) => {
  const p = tar.x({ cwd: d, strict: true }); p.on('close', res); p.on('error', rej); p.end(b)
})

// raw floor: same tree, same sizes, sequential sync writes (no per-file chmod/utimes)
const floor = (dest) => {
  for (const f of files) {
    const p = path.join(dest, f.path)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, Buffer.alloc(f.size, 97))
  }
}

;(async () => {
  const row = { tar: [], codec: [], floor: [] }
  for (let i = 0; i < 7; i++) {
    let d = W + '-tar'; fresh(d); let t = performance.now(); await x(buf, d); row.tar.push(performance.now() - t)
    d = W + '-codec'; fresh(d); t = performance.now(); codec.extract(buf, d, true); row.codec.push(performance.now() - t)
    d = W + '-floor'; fresh(d); t = performance.now(); floor(d); row.floor.push(performance.now() - t)
    fs.rmSync(W + '-tar', { recursive: true, force: true })
    fs.rmSync(W + '-codec', { recursive: true, force: true })
    fs.rmSync(W + '-floor', { recursive: true, force: true })
  }
  for (const [k, v] of Object.entries(row)) console.log(k.padEnd(6), med(v).toFixed(1) + ' ms', '(' + files.length + ' files)')

  // concurrency scaling: 8 copies of the same archive at once
  const run = async (fn) => {
    const base = W + '-par'
    fresh(base)
    const t = performance.now()
    await Promise.all(Array.from({ length: 8 }, (_, i) => {
      const d = path.join(base, String(i))
      fs.mkdirSync(d, { recursive: true })
      return fn(buf, d)
    }))
    const el = performance.now() - t
    fs.rmSync(base, { recursive: true, force: true })
    return el
  }
  const a = [], b = []
  for (let i = 0; i < 5; i++) {
    a.push(await run(x))
    b.push(await run((bb, d) => codec.extractAsync(bb, d, true)))
  }
  console.log('8x parallel lodash: node-tar', med(a).toFixed(1), 'ms; tar-codec async', med(b).toFixed(1), 'ms')

  results.write('floor', {
    files: files.length,
    tar: row.tar,
    codec: row.codec,
    floor: row.floor,
    parallel: { copies: 8, tar: a, codec: b },
  })
})()
