// Install-shaped benchmark: extract a real dependency closure.
// Arms:
//   tar-N              node-tar on .tgz, strip:1, concurrency N
//   codec-gunzip-N     JS gunzipSync (main thread) + tar-codec, concurrency N
//   codec-asyncgz-N    async zlib gunzip (threadpool) + tar-codec, concurrency N
//   codec-nativegz-N   gzip inflated inside the addon with zlib-rs, concurrency N
//
// tar-codec 0.0.15 has no strip option, so the codec arms extract into a
// staging dir and rename package/ into place. That is the workaround a real
// wrapper would need, and its cost is inside the timed region. Every arm's tree
// is compared against the tar-1 reference, so "install-shaped" means the same
// paths and bytes, not just a matching file count.
const ROOT = __dirname
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const { performance } = require('perf_hooks')
const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')
const { WORK } = require('./lib/work')
const tree = require('./lib/tree')
const results = require('./lib/results')

const CORPUS = ROOT + '/corpus'
const DEPS = require(CORPUS + '/deps.json')
const W = path.join(WORK, 'install')
const ITER = Number(process.argv[2] || 3)

// npm only installs the platform-matching optional binaries; the walk grabbed every
// @typescript/typescript-* package (177 of the 184 MB), which is not a real install.
const SELECT = process.env.ALL ? DEPS : DEPS.filter(d => !/^@typescript\/typescript-/.test(d.name))
const pkgs = SELECT.map(d => ({ ...d, tgz: fs.readFileSync(path.isAbsolute(d.file) ? d.file : path.join(CORPUS, d.file)) }))
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

const arms = {
  'tar-1': { kind: 'tar', par: 1 },
  'tar-8': { kind: 'tar', par: 8 },
  'codec-gunzip-1': { kind: 'gunzip', par: 1 },
  'codec-asyncgz-8': { kind: 'asyncgz', par: 8 },
  'codec-nativegz-1': { kind: 'nativegz', par: 1 },
  'codec-nativegz-8': { kind: 'nativegz', par: 8 },
}

// tar-codec has no strip, so land the archive root in a staging dir and rename
// it into place. Most npm tarballs use package/, but not all (@types/estree
// uses estree/), so take whatever single top-level entry the archive has.
const extractStripped = async (base, i, dest, fn) => {
  const staging = path.join(base, '.staging', String(i))
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  await fn(staging)
  const roots = fs.readdirSync(staging)
  if (!roots.length) throw new Error(`${pkgs[i].name}: archive extracted nothing`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (roots.length === 1 && fs.statSync(path.join(staging, roots[0])).isDirectory()) {
    fs.renameSync(path.join(staging, roots[0]), dest)
  } else {
    fs.mkdirSync(dest, { recursive: true })
    for (const r of roots) fs.renameSync(path.join(staging, r), path.join(dest, r))
  }
  fs.rmSync(staging, { recursive: true, force: true })
}

const runArm = async ({ kind, par }) => {
  const base = path.join(W, '-' + kind + '-' + par)
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(base, { recursive: true })
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
    const dest = path.join(base, pkgs[i].name)
    if (kind === 'tar') {
      fs.mkdirSync(dest, { recursive: true })
      await tarExtract(pkgs[i].tgz, dest)
    } else if (kind === 'nativegz') {
      await extractStripped(base, i, dest, (staging) => codec.extractGzAsync(pkgs[i].tgz, staging, true))
    } else if (par === 1) {
      await extractStripped(base, i, dest, (staging) => Promise.resolve(codec.extract(raws[i], staging, true)))
    } else {
      await extractStripped(base, i, dest, (staging) => codec.extractAsync(raws[i], staging, true))
    }
  }
  if (par === 1) for (let i = 0; i < pkgs.length; i++) await one(i)
  else for (const group of chunk(pkgs.map((_, i) => i), par)) await Promise.all(group.map(one))
  const t = performance.now() - t0
  fs.rmSync(path.join(base, '.staging'), { recursive: true, force: true })
  const sig = tree.walk(base)
  let bytes = 0
  for (const [k, v] of sig) if (/^\d+:/.test(v)) bytes += Number(v.split(':')[0])
  fs.rmSync(base, { recursive: true, force: true })
  return { total: t + inflate, extract: t, inflate, sig, bytes }
}

const sameTree = (a, b) => {
  if (a.size !== b.size) return { ok: false, files: `${a.size} vs ${b.size}` }
  for (const [k, v] of a) if (b.get(k) !== v) return { ok: false, files: `differs at ${k}` }
  return { ok: true }
}

;(async () => {
  console.log(`${pkgs.length} packages, ${(totalGz / 1024 / 1024).toFixed(0)} MB of .tgz`)
  const runs = {}
  for (const name of Object.keys(arms)) runs[name] = []
  let reference = null
  let files = 0
  let unpacked = 0

  for (let i = 0; i < ITER + 1; i++) {
    for (const name of Object.keys(arms)) {
      const r = await runArm(arms[name])
      if (!reference) {
        reference = r.sig
        files = [...r.sig.keys()].filter(k => !k.endsWith('/')).length
        unpacked = r.bytes
      }
      const cmp = sameTree(reference, r.sig)
      if (i === 0 || !cmp.ok) {
        console.log(`  sanity ${name}: ${files} files, ${(unpacked / 1024 / 1024).toFixed(0)} MB, tree ${cmp.ok ? 'matches tar-1' : 'MISMATCH: ' + cmp.files}`)
      }
      if (!cmp.ok) throw new Error(`${name} did not produce the same tree: ${cmp.files}`)
      if (i > 0) runs[name].push(r)
    }
  }

  const table = Object.keys(arms).map(name => {
    const rs = runs[name]
    return {
      name,
      kind: arms[name].kind,
      par: arms[name].par,
      extract: rs.map(r => r.extract),
      inflate: rs.map(r => r.inflate),
      total: rs.map(r => r.total),
    }
  })

  results.write('install', {
    iterations: ITER,
    packages: pkgs.length,
    gzBytes: totalGz,
    files,
    unpackedBytes: unpacked,
    arms: table,
  })

  console.log('')
  console.log('| arm | extract | inflate | total | vs tar-1 | vs tar-8 | tree |')
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  const base1 = med(table[0].total)
  const base8 = med(table[1].total)
  for (const a of table) {
    const t = med(a.total)
    console.log(`| ${a.name} | ${med(a.extract).toFixed(0)} ms | ${med(a.inflate).toFixed(0)} ms | ${t.toFixed(0)} ms | ${(base1 / t).toFixed(2)}x | ${(base8 / t).toFixed(2)}x | same |`)
  }
})()
