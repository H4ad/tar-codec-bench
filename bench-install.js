// Install-shaped benchmark: extract a real 150-package dependency closure.
// Arms:
//   tar-N              node-tar on .tgz, concurrency N
//   codec-gunzip-N     JS gunzipSync (main thread) + tar-codec, concurrency N
//   codec-asyncgz-N    async zlib gunzip (threadpool) + tar-codec, concurrency N
//   codec-nativegz-N   gzip inflated inside the addon with zlib-rs, concurrency N
const ROOT = __dirname
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const { performance } = require('perf_hooks')
const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')

const DEPS = require(ROOT + '/corpus/deps.json')
const W = ROOT + '/work/install'
const ITER = Number(process.argv[2] || 3)

// npm only installs the platform-matching optional binaries; the walk grabbed every
// @typescript/typescript-* package (177 of the 184 MB), which is not a real install.
const SELECT = process.env.ALL ? DEPS : DEPS.filter(d => !/^@typescript\/typescript-/.test(d.name))
const pkgs = SELECT.map(d => ({ ...d, tgz: fs.readFileSync(d.file) }))
const totalGz = pkgs.reduce((a, p) => a + p.tgz.length, 0)
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

const tarExtract = (buf, dest) => new Promise((res, rej) => {
  const p = tar.x({ cwd: dest, strict: true, strip: 1 })
  p.on('close', res)
  p.on('error', rej)
  p.end(buf)
})

const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

function walkSize (root) {
  let n = 0
  let files = 0
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else { n += fs.statSync(p).size; files++ }
    }
  }
  return { n, files }
}

const arms = {
  'tar-1': { kind: 'tar', par: 1 },
  'tar-8': { kind: 'tar', par: 8 },
  'codec-gunzip-1': { kind: 'gunzip', par: 1 },
  'codec-asyncgz-8': { kind: 'asyncgz', par: 8 },
  'codec-nativegz-1': { kind: 'nativegz', par: 1 },
  'codec-nativegz-8': { kind: 'nativegz', par: 8 },
}

const runArm = async ({ kind, par }) => {
  const base = W + '-' + kind + '-' + par
  fs.rmSync(base, { recursive: true, force: true })
  let raws = null
  let inflate = 0
  if (kind === 'gunzip') {
    const t = performance.now()
    raws = pkgs.map(p => zlib.gunzipSync(p.tgz))
    inflate = performance.now() - t
  } else if (kind === 'asyncgz') {
    const t = performance.now()
    raws = await Promise.all(pkgs.map(p => new Promise((res, rej) =>
      zlib.gunzip(p.tgz, (e, b) => e ? rej(e) : res(b)))))
    inflate = performance.now() - t
  }
  const t0 = performance.now()
  const one = async (i) => {
    const d = path.join(base, pkgs[i].name)
    fs.mkdirSync(d, { recursive: true })
    if (kind === 'tar') await tarExtract(pkgs[i].tgz, d)
    else if (kind === 'nativegz') await codec.extractGzAsync(pkgs[i].tgz, d, true)
    else if (par === 1) codec.extract(raws[i], d, true)
    else await codec.extractAsync(raws[i], d, true)
  }
  if (par === 1) for (let i = 0; i < pkgs.length; i++) await one(i)
  else for (const group of chunk(pkgs.map((_, i) => i), par)) await Promise.all(group.map(one))
  const t = performance.now() - t0
  const bytes = walkSize(base)
  fs.rmSync(base, { recursive: true, force: true })
  return { total: t + inflate, extract: t, inflate, bytes }
}

;(async () => {
  console.log(`${pkgs.length} packages, ${(totalGz / 1024 / 1024).toFixed(0)} MB of .tgz`)
  const results = {}
  for (const name of Object.keys(arms)) results[name] = []
  for (let i = 0; i < ITER + 1; i++) {
    for (const name of Object.keys(arms)) {
      const r = await runArm(arms[name])
      if (i === 0) {
        console.log(`  sanity ${name}: ${r.bytes.files} files, ${(r.bytes.n / 1024 / 1024).toFixed(0)} MB`)
      } else results[name].push(r)
    }
  }
  console.log('')
  console.log('| arm | extract | inflate | total | vs tar-1 | vs tar-8 |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  const base1 = med(results['tar-1'].map(r => r.total))
  const base8 = med(results['tar-8'].map(r => r.total))
  for (const name of Object.keys(arms)) {
    const rs = results[name]
    const t = med(rs.map(r => r.total))
    console.log(`| ${name} | ${med(rs.map(r => r.extract)).toFixed(0)} ms | ${med(rs.map(r => r.inflate)).toFixed(0)} ms | ${t.toFixed(0)} ms | ${(base1 / t).toFixed(2)}x | ${(base8 / t).toFixed(2)}x |`)
  }
})()
