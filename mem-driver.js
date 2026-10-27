// Driver: median peak RSS across separate processes per arm.
const path = require('path')
const ROOT = __dirname
const { spawnSync } = require('child_process')

const cases = [
  { corpus: 'lodash', iters: 5, par: 1 },
  { corpus: 'many-small', iters: 2, par: 1 },
  { corpus: 'lodash.tgz', iters: 5, par: 1 },
  { corpus: 'lodash', iters: 8, par: 8 },
  { corpus: 'many-small', iters: 3, par: 8 },
]
const arms = ['baseline', 'tar', 'codec', 'codec-async', 'codec-gz']

const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

console.log('| case | arm | peak RSS | delta over idle |')
console.log('| --- | --- | --- | --- |')
for (const c of cases) {
  const row = {}
  for (const arm of arms) {
    if (arm === 'codec-gz' && !c.corpus.endsWith('.tgz')) continue
    if (arm !== 'codec-gz' && c.corpus.endsWith('.tgz') && arm === 'codec') continue
    if (arm !== 'codec-gz' && c.corpus.endsWith('.tgz') && arm === 'codec-async') continue
    const peaks = [], deltas = []
    for (let i = 0; i < 3; i++) {
      const r = spawnSync(process.execPath, [ROOT + '/mem.js', arm, c.corpus, c.iters, c.par], { encoding: 'utf8' })
      if (r.status !== 0) { console.log('FAIL', c.corpus, arm, r.stderr.split('\n')[0]); continue }
      const [peak, delta] = r.stdout.trim().split(' ').map(Number)
      peaks.push(peak / 1024)
      deltas.push(delta / 1024)
    }
    row[arm] = { peak: med(peaks), delta: med(deltas) }
  }
  for (const [arm, v] of Object.entries(row)) {
    console.log(`| ${c.corpus} x${c.iters}${c.par > 1 ? ` par ${c.par}` : ''} | ${arm} | ${v.peak.toFixed(0)} MB | ${v.delta > 0 ? '+' : ''}${v.delta.toFixed(0)} MB |`)
  }
}
