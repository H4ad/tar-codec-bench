// Generates pax tarballs with node-tar, mimicking "npm pack" layout (prefix package/).
const ROOT = __dirname
const tar = require('tar')
const fs = require('fs')
const path = require('path')

const cases = [
  { name: 'many-small', files: 10000, size: 1024 },
  { name: 'few-large', files: 50, size: 200 * 1024 },
]

const crypto = require('crypto')
const body = n => crypto.randomBytes(n)

;(async () => {
  for (const c of cases) {
    const root = path.join(ROOT + '/work', 'src-' + c.name)
    fs.rmSync(root, { recursive: true, force: true })
    for (let i = 0; i < c.files; i++) {
      const dir = path.join(root, 'package', 'dist', `d${Math.floor(i / 100)}`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `file-${i}.js`), body(c.size))
    }
    const out = path.join(ROOT + '/corpus', c.name + '.tar')
    await tar.c({ cwd: root, file: out, portable: true }, ['package'])
    console.log(out, fs.statSync(out).size)
    fs.rmSync(root, { recursive: true, force: true })
  }
})()
