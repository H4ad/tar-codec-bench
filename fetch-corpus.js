// Downloads the three registry tarballs the benchmarks use and prepares both the
// raw tar and the gzipped copy. Versions are pinned so a later run reproduces
// the numbers in results/.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = __dirname
const CORPUS = path.join(ROOT, 'corpus')
const PINNED = {
  lodash: '4.18.1',
  typescript: '7.0.2',
  eslint: '10.13.0',
}

;(async () => {
  fs.mkdirSync(CORPUS, { recursive: true })
  for (const [name, version] of Object.entries(PINNED)) {
    const res = await fetch(`https://registry.npmjs.org/${name}/${version}`)
    if (!res.ok) throw new Error(`${name}@${version}: ${res.status}`)
    const meta = await res.json()
    const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer())
    fs.writeFileSync(path.join(CORPUS, name + '.tgz'), tgz)
    fs.writeFileSync(path.join(CORPUS, name + '.tar.gz'), tgz)
    fs.writeFileSync(path.join(CORPUS, name + '.tar'), zlib.gunzipSync(tgz))
    console.log(`${name}@${meta.version}: ${tgz.length} bytes gzipped`)
  }
})()
