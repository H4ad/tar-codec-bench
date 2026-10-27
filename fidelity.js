// Fidelity: what does each extractor do with modes, mtimes, symlinks, hardlinks?
const ROOT = __dirname
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const tar = require('tar')
const codec = require(ROOT + '/tarcodec.node')

const T = ROOT + '/work/fidelity'
const src = T + '/src/package'
const archive = T + '/fidelity.tar'
const W = ROOT + '/work/fidelity'

const x = (buf, dest) => new Promise((res, rej) => {
  const p = tar.x({ cwd: dest, strict: true }); p.on('close', res); p.on('error', rej); p.end(buf)
})

const describe = (root) => {
  const out = {}
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name
      const abs = path.join(root, r)
      const st = fs.lstatSync(abs)
      if (e.isDirectory()) { out[r] = `dir ${(st.mode & 0o777).toString(8)}`; walk(r) } else if (e.isSymbolicLink()) out[r] = 'symlink -> ' + fs.readlinkSync(abs)
      else out[r] = `file ${(st.mode & 0o777).toString(8)} mtime=${Math.round(st.mtimeMs / 1000)} size=${st.size}`
    }
  }
  walk('')
  return out
}

fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(src, { recursive: true })
fs.writeFileSync(src + '/secret.txt', 'secret')
fs.chmodSync(src + '/secret.txt', 0o600)
fs.writeFileSync(src + '/private.sh', '#!/bin/sh\n')
fs.chmodSync(src + '/private.sh', 0o700)
fs.writeFileSync(src + '/normal.js', 'x')
fs.chmodSync(src + '/normal.js', 0o644)
fs.symlinkSync('normal.js', src + '/link.js')
fs.linkSync(src + '/normal.js', src + '/hard.js')
const old = new Date('2020-01-01T00:00:00Z')
for (const f of ['secret.txt', 'private.sh', 'normal.js']) fs.utimesSync(src + '/' + f, old, old)

execFileSync('tar', ['--format=pax', '-cf', archive, '-C', T + '/src', 'package'])
const buf = fs.readFileSync(archive)
console.log('original:')
const orig = describe(src)
for (const [k, v] of Object.entries(orig)) console.log('  ' + k.padEnd(20) + v)

const a = W + '/x-tar', b = W + '/x-codec'
for (const d of [a, b]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }) }
;(async () => {
  await x(buf, a)
  try { codec.extract(buf, b, true, true) } catch (e) { console.log('codec extract failed:', e.message) }
  console.log('\nnode-tar:')
  for (const [k, v] of Object.entries(describe(a))) console.log('  ' + k.padEnd(20) + v)
  console.log('\ntar-codec:')
  for (const [k, v] of Object.entries(describe(b))) console.log('  ' + k.padEnd(20) + v)
  fs.rmSync(W, { recursive: true, force: true })
})()
