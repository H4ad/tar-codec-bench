// Generates pax tarballs with node-tar, mimicking "npm pack" layout (prefix package/).
// Writes both .tar and .tar.gz so bench-e2e.js has the gzipped corpus it reads.
const ROOT = __dirname
const tar = require('tar')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { WORK, fresh } = require('./lib/work')

const cases = [
  { name: 'many-small', files: 10000, size: 1024 },
  { name: 'few-large', files: 50, size: 200 * 1024 },
]

const crypto = require('crypto')
const body = n => crypto.randomBytes(n)

;(async () => {
  for (const c of cases) {
    const root = path.join(WORK, 'src-' + c.name)
    fresh(root)
    for (let i = 0; i < c.files; i++) {
      const dir = path.join(root, 'package', 'dist', `d${Math.floor(i / 100)}`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `file-${i}.js`), body(c.size))
    }
    const out = path.join(ROOT, 'corpus', c.name + '.tar')
    await tar.c({ cwd: root, file: out, portable: true }, ['package'])
    fs.writeFileSync(out + '.gz', zlib.gzipSync(fs.readFileSync(out), { level: 6 }))
    console.log(out, fs.statSync(out).size, 'and', fs.statSync(out + '.gz').size, 'gzipped')
    fs.rmSync(root, { recursive: true, force: true })
  }
})()
