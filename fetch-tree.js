// Download the latest versions of a real dependency closure, to mimic an install.
const ROOT = __dirname
const fs = require('fs')
const path = require('path')

const ROOTS = ['eslint', 'express', 'typescript', 'webpack', 'jest']
const MAX = Number(process.argv[2] || 150)
const OUT = ROOT + '/corpus/deps'

const reg = async (name) => {
  const r = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`)
  if (!r.ok) throw new Error(`${name} ${r.status}`)
  return r.json()
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const queue = [...ROOTS]
  const seen = new Set()
  const got = []
  while (queue.length && got.length < MAX) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    let m
    try { m = await reg(name) } catch { continue }
    const tarball = m.dist.tarball
    const file = path.join(OUT, name.replace('/', '+') + '.tgz')
    const r = await fetch(tarball)
    if (!r.ok) { console.log('skip', name, r.status); continue }
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
    got.push({ name, version: m.version, file, deps: Object.keys(m.dependencies || {}) })
    console.log(`${got.length} ${name}@${m.version}`)
    for (const d of Object.keys(m.dependencies || {})) if (!seen.has(d)) queue.push(d)
  }
  fs.writeFileSync(ROOT + '/corpus/deps.json', JSON.stringify(got, null, 1))
  const total = got.reduce((a, g) => a + fs.statSync(g.file).size, 0)
  console.log(`\n${got.length} packages, ${(total / 1024 / 1024).toFixed(1)} MB of .tgz`)
})()
