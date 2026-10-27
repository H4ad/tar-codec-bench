// Driver: median peak RSS across separate processes per arm.
// The arm charted for a concurrent case is the async one, because a blocking
// napi call cannot overlap: eight of them run one after another in one tick.
const path = require('path')
const ROOT = __dirname
const { spawnSync } = require('child_process')
const results = require('./lib/results')

const cases = [
  {
    id: 'lodash-1',
    workload: 'lodash, 1051 entries, 5 extractions',
    corpus: 'lodash',
    iters: 5,
    par: 1,
    arms: ['baseline', 'tar', 'codec', 'codec-async'],
  },
  {
    id: 'many-small-1',
    workload: '10k files, 2 extractions',
    corpus: 'many-small',
    iters: 2,
    par: 1,
    arms: ['baseline', 'tar', 'codec', 'codec-async'],
  },
  {
    id: 'lodash-tgz-1',
    workload: 'lodash.tgz, 5 extractions',
    corpus: 'lodash.tgz',
    iters: 5,
    par: 1,
    arms: ['baseline', 'tar', 'codec-gz', 'codec-gz-async'],
  },
  {
    id: 'lodash-8',
    workload: 'lodash, 8 concurrent',
    corpus: 'lodash',
    iters: 8,
    par: 8,
    arms: ['baseline', 'tar', 'codec', 'codec-async'],
  },
  {
    id: 'many-small-8',
    workload: '10k files, 8 concurrent',
    corpus: 'many-small',
    iters: 3,
    par: 8,
    arms: ['baseline', 'tar', 'codec', 'codec-async'],
  },
]

const RUNS = 3
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const round = n => Math.round(n)

const stat = (a) => ({ median: round(med(a)), min: round(Math.min(...a)), max: round(Math.max(...a)), runs: a })

console.log('| case | arm | peak RSS | peak over idle | retained delta | peak range |')
console.log('| --- | --- | --- | --- | --- | --- |')
const out = []
for (const c of cases) {
  const row = { ...c, arms: {} }
  for (const arm of c.arms) {
    const peaks = [], deltas = []
    for (let i = 0; i < RUNS; i++) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'mem.js'), arm, c.corpus, c.iters, c.par], { encoding: 'utf8' })
      if (r.status !== 0) {
        console.log('FAIL', c.corpus, arm, (r.stderr || '').split('\n')[0])
        continue
      }
      const [peak, delta] = r.stdout.trim().split(' ').map(Number)
      peaks.push(peak / 1024)
      deltas.push(delta / 1024)
    }
    row.arms[arm] = { peak: stat(peaks), delta: stat(deltas) }
    const idle = row.arms.baseline ? row.arms.baseline.peak.median : null
    const over = idle == null ? '' : `+${round(row.arms[arm].peak.median - idle)} MB`
    console.log(`| ${c.workload} | ${arm} | ${round(row.arms[arm].peak.median)} MB | ${over} | +${round(row.arms[arm].delta.median)} MB | ${row.arms[arm].peak.min} to ${row.arms[arm].peak.max} MB |`)
  }
  out.push(row)
}

results.write('memory', { processes: RUNS, cases: out })
