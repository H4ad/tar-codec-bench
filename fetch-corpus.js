// Downloads the three registry tarballs the benchmarks use and prepares both the
// raw tar and the gzipped copy.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = __dirname
const CORPUS = path.join(ROOT, 'corpus')
const names = ['lodash', 'typescript', 'eslint']

;(async () => {
  fs.mkdirSync(CORPUS, { recursive: true })
  for (const name of names) {
    const meta = await (await fetch(`https://registry.npmjs.org/${name}/latest`)).json()
    const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer())
    fs.writeFileSync(path.join(CORPUS, name + '.tgz'), tgz)
    fs.writeFileSync(path.join(CORPUS, name + '.tar.gz'), tgz)
    fs.writeFileSync(path.join(CORPUS, name + '.tar'), zlib.gunzipSync(tgz))
    console.log(`${name}@${meta.version}: ${tgz.length} bytes gzipped`)
  }
})()
