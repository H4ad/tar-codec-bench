// Every benchmark writes results/<name>.json and page.mjs reads those files, so
// the published page cannot drift from the measurement it claims to show.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { WORK } = require('./work')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'results')

const fstype = (target) => {
  try {
    const real = fs.realpathSync(target)
    let best = { mount: '', type: 'unknown' }
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [dev, mount, type] = line.split(' ')
      if (!mount) continue
      const m = mount.replace(/\\040/g, ' ')
      if ((real === m || real.startsWith(m.endsWith('/') ? m : m + '/')) && m.length > best.mount.length) {
        best = { mount: m, type }
      }
    }
    return best.type
  } catch {
    return 'unknown'
  }
}

const cargoVersion = () => {
  try {
    const cargo = fs.readFileSync(path.join(ROOT, 'rust/Cargo.toml'), 'utf8')
    const m = cargo.match(/tar-codec\s*=\s*"([^"]+)"/)
    return m ? m[1] : 'unknown'
  } catch {
    return 'unknown'
  }
}

const meta = () => {
  const pkg = require('../package.json')
  const cpu = os.cpus()[0]
  return {
    date: new Date().toISOString(),
    machine: `${os.hostname()} (${cpu ? cpu.model.trim() : 'unknown CPU'}, ${os.cpus().length} threads)`,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    nodeTar: pkg.dependencies.tar,
    tarCodec: cargoVersion(),
    workDir: WORK,
    workFs: fstype(WORK),
  }
}

const write = (name, data) => {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify({ ...meta(), ...data }, null, 1) + '\n')
  console.log(`wrote results/${name}.json`)
}

const read = (name) => JSON.parse(fs.readFileSync(path.join(OUT, name + '.json'), 'utf8'))

module.exports = { write, read, meta, OUT }
