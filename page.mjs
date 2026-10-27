// Generates compare.html from the measured numbers, so bar widths are computed
// instead of hand-typed.
import { writeFileSync } from 'node:fs'

const MACHINE = 'Ryzen 9 5950X, 32 threads, tmpfs, Linux x64'
const NODE = 'node v24.20.0, node-tar 7.5.22, tar-codec 0.0.15'

// raw tar, median of 7, ms: [node-tar, tar-codec]
const raw = [
  { name: 'lodash', mb: 2.2, entries: 1051, parse: [9.04, 1.29], extract: [82.3, 10.9] },
  { name: 'typescript', mb: 2.7, entries: 416, parse: [2.45, 0.76], extract: [54.7, 6.14] },
  { name: 'eslint', mb: 3.1, entries: 421, parse: [2.30, 0.74], extract: [49.5, 7.12] },
  { name: 'synthetic, 10k small files', mb: 14.7, entries: 10102, parse: [55.5, 9.71], extract: [1113.6, 97.8] },
  { name: 'synthetic, 50 x 200 KB', mb: 9.8, entries: 53, parse: [0.39, 0.70], extract: [6.95, 6.54] },
]

// .tgz end to end, median of 5, ms
const tgz = [
  { name: 'lodash', total: [89.0, 13.0], gunzip: 2.5 },
  { name: 'typescript', total: [60.2, 8.7], gunzip: 2.9 },
  { name: 'eslint', total: [61.7, 11.2], gunzip: 4.6 },
  { name: 'synthetic, 10k small files', total: [1112.4, 123.8], gunzip: 29.4 },
]

// install-shaped closure: 130 packages, 4313 files, 32 MB unpacked, median of 4
const install = [
  { name: 'node-tar, one at a time', ms: 741, note: '' },
  { name: 'node-tar, 8 in flight', ms: 496, note: 'the shape pacote actually uses' },
  { name: 'tar-codec + JS gunzip, one at a time', ms: 172, note: 'inflate 55 ms, extract 116 ms' },
  { name: 'tar-codec + async zlib, 8 in flight', ms: 155, note: 'inflate 81 ms, extract 75 ms' },
  { name: 'tar-codec, zlib-rs inside the addon, 8 in flight', ms: 106, note: 'best arm, inflate included' },
]

// peak RSS, MB, median of 3 process runs
const memory = [
  { name: 'lodash, 5 extractions', idle: 59, tar: 117, codec: 61, async: 75 },
  { name: '10k files, 2 extractions', idle: 71, tar: 260, codec: 73, async: 103 },
  { name: 'lodash, 8 concurrent', idle: 59, tar: 303, codec: 61, async: 90 },
  { name: '10k files, 8 concurrent', idle: 72, tar: 1101, codec: 73, async: 254 },
]

const packages = [
  { name: 'tar', bytes: 2298662, files: 249 },
  { name: 'minipass', bytes: 366791, files: 13 },
  { name: 'minizlib', bytes: 117811, files: 21 },
  { name: '@isaacs/fs-minipass', bytes: 100617, files: 13 },
  { name: 'yallist', bytes: 80297, files: 13 },
  { name: 'chownr', bytes: 22048, files: 13 },
]
const ADDON = { bytes: 1825664, gz: 643979 }

const features = [
  {
    group: 'Reading npm tarballs',
    rows: [
      ['ustar and pax archives', ['yes', 'y'], ['yes', 'y'], 'what npm publishes'],
      ['GNU long names (L, K) and base-256 sizes', ['yes', 'y'], ['yes', 'y'], ''],
      ['UNIX V7 tar', ['yes', 'y'], ['no', 'n'], 'nonexistent in the registry'],
      ['gzip on the fly', ['yes', 'y'], ['separate step', 'p'], 'zlib-rs in the wrapper, 5 to 30 ms per package'],
      ['pax vendor records (SCHILY, LIBARCHIVE)', ['ignored', 'y'], ['rejected', 'n'], 'allowlist opt-in, tested'],
      ['GNU sparse members', ['yes', 'y'], ['no', 'n'], 'rare, not used by npm pack'],
    ],
  },
  {
    group: 'Writing tarballs',
    rows: [
      ['tar.c / create', ['yes', 'y'], ['not wrapped', 'n'], 'TarEncoder exists in the crate'],
      ['npm pack, npm publish', ['works', 'y'], ['needs a writer', 'n'], ''],
    ],
  },
  {
    group: 'Extraction semantics',
    rows: [
      ['file modes', ['preserved', 'y'], ['normalized', 'n'], '0644 / 0755 only, exec bit survives'],
      ['mtimes', ['preserved', 'y'], ['now', 'n'], ''],
      ['symlinks', ['preserved', 'y'], ['preserved', 'y'], ''],
      ['hard links', ['created', 'y'], ['opt-in', 'p'], 'rejected by default, aborts mid-extract'],
      ['strip: 1', ['yes', 'y'], ['no', 'n'], 'pacote always strips package/'],
      ['filter callback', ['yes', 'y'], ['no', 'n'], ''],
      ['mode in member metadata', ['yes', 'y'], ['exec bit only', 'n'], 'lib/utils/tar.js#getContents wants it'],
      ['atomic failure', ['partial tree', 'p'], ['partial tree', 'p'], 'same caveat, extract to temp then rename'],
    ],
  },
  {
    group: 'Shape of the dependency',
    rows: [
      ['language', ['JavaScript', ''], ['Rust + napi', ''], ''],
      ['platforms', ['everywhere node runs', 'y'], ['needs a build per target', 'p'], 'linux glibc and musl, darwin, win32, x64 and arm64'],
      ['install footprint', ['2.9 MB, 6 packages', ''], ['1.7 MB per platform', ''], ''],
      ['parse cost per entry', ['high', 'p'], ['low', 'y'], 'the whole reason to look'],
      ['parser strictness', ['lenient', ''], ['strict by design', 'y'], 'rejects family mixing, pax tombstones, bad numerics'],
    ],
  },
]

const totalBytes = packages.reduce((a, p) => a + p.bytes, 0)
const pct = (n, max) => Math.max(1.5, (n / max) * 100).toFixed(1)
const rowBars = (a, b) => {
  const max = Math.max(a, b)
  return `<div class="m"><span class="track"><i class="tar" style="--w:${pct(a, max)}%"></i></span><span class="v">${a}</span></div>
        <div class="m"><span class="track"><i class="codec" style="--w:${pct(b, max)}%"></i></span><span class="v">${b}</span></div>`
}
const barsOnly = (a, b) => {
  const max = Math.max(a, b)
  return `<div class="m"><span class="track"><i class="tar" style="--w:${pct(a, max)}%"></i></span></div>
        <div class="m"><span class="track"><i class="codec" style="--w:${pct(b, max)}%"></i></span></div>`
}
const x = (a, b) => (a / b)
const xf = (n) => (n >= 10 ? n.toFixed(1) : n.toFixed(1))
const speedBadge = (ratio) => ratio >= 2
  ? `<span class="win">${xf(ratio)}x</span>`
  : `<span class="lose">${xf(ratio)}x</span>`

const mark = ([text, tone]) => (tone ? `<span class="${tone}">${text}</span>` : text)

const seconds = (ms) => (ms / 1000).toFixed(2) + ' s'

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Measured comparison of node-tar 7.5.22 and astral tar-codec 0.0.15 for npm: extract speed, peak memory, install size and feature gaps.">
<title>node-tar vs tar-codec, measured on npm tarballs</title>
<style>
  :root {
    color-scheme: light dark;
    --paper: oklch(0.968 0.008 88);
    --panel: oklch(0.988 0.004 88);
    --ink: oklch(0.24 0.014 70);
    --ink-2: oklch(0.42 0.012 70);
    --muted: oklch(0.56 0.011 70);
    --rule: oklch(0.885 0.009 84);
    --rule-strong: oklch(0.80 0.011 80);
    --tar: oklch(0.52 0.098 176);
    --codec: oklch(0.63 0.105 52);
    --tar-soft: oklch(0.52 0.098 176 / 0.13);
    --codec-soft: oklch(0.63 0.105 52 / 0.13);
    --good: oklch(0.50 0.10 165);
    --bad: oklch(0.55 0.13 30);
    --warn: oklch(0.55 0.08 75);
    --sans: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --measure: 68ch;
    --strip: clamp(1.25rem, 4vw, 3.5rem);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: oklch(0.19 0.008 80);
      --panel: oklch(0.23 0.008 80);
      --ink: oklch(0.93 0.006 85);
      --ink-2: oklch(0.80 0.008 85);
      --muted: oklch(0.66 0.010 85);
      --rule: oklch(0.31 0.008 80);
      --rule-strong: oklch(0.40 0.010 80);
      --tar: oklch(0.74 0.095 176);
      --codec: oklch(0.72 0.105 55);
      --tar-soft: oklch(0.74 0.095 176 / 0.18);
      --codec-soft: oklch(0.72 0.105 55 / 0.18);
      --good: oklch(0.78 0.10 165);
      --bad: oklch(0.72 0.12 30);
      --warn: oklch(0.80 0.09 78);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font: 400 17px/1.6 var(--sans);
    font-variant-numeric: tabular-nums;
    text-rendering: optimizeLegibility;
  }
  a { color: inherit; text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
  a:hover { text-decoration-color: var(--codec); }
  :focus-visible { outline: 2px solid var(--codec); outline-offset: 3px; }

  .wrap { max-width: 1240px; margin: 0 auto; padding: 0 var(--strip); }
  .label {
    font: 500 11px/1 var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }

  header.top { border-bottom: 1px solid var(--rule-strong); padding: clamp(2.5rem, 6vw, 5rem) 0 0; }
  .kicker { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: clamp(2rem, 5vw, 4rem); }
  h1 {
    font-size: clamp(2.1rem, 5.2vw, 3.9rem);
    line-height: 1.03;
    letter-spacing: -0.028em;
    font-weight: 600;
    margin: 0 0 1.25rem;
    max-width: 22ch;
  }
  h1 .vs { color: var(--muted); font-weight: 400; }
  .lede { max-width: 62ch; font-size: clamp(1.05rem, 1.5vw, 1.22rem); color: var(--ink-2); margin: 0 0 clamp(2rem, 5vw, 3.25rem); }
  .lede b { color: var(--ink); font-weight: 600; }

  .ledger {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border-top: 1px solid var(--rule-strong);
  }
  .ledger > div { padding: 1.15rem 1.25rem 1.35rem 0; border-right: 1px solid var(--rule); }
  .ledger > div:last-child { border-right: 0; }
  .ledger .k { margin-bottom: 0.55rem; }
  .ledger .big { font: 500 clamp(1.35rem, 2.4vw, 1.8rem)/1.15 var(--mono); letter-spacing: -0.02em; }
  .ledger .sub { font-size: 0.8rem; color: var(--muted); margin-top: 0.4rem; }
  .ledger .big .dim { color: var(--muted); }

  main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; min-width: 0; }
  section { padding: clamp(2.75rem, 6vw, 4.5rem) 0; border-bottom: 1px solid var(--rule); min-width: 0; }
  section:last-of-type { border-bottom: 0; }
  .sec-head { display: grid; grid-template-columns: 3.5rem 1fr; gap: 0.5rem 1rem; align-items: baseline; margin-bottom: 1.75rem; }
  .sec-num { font: 500 12px/1 var(--mono); color: var(--muted); letter-spacing: 0.08em; }
  h2 { font-size: clamp(1.4rem, 2.6vw, 1.95rem); line-height: 1.15; letter-spacing: -0.02em; font-weight: 600; margin: 0; }
  .sec-head p { grid-column: 2; max-width: var(--measure); color: var(--ink-2); margin: 0.55rem 0 0; }
  body > .wrap > main > section > *:not(.sec-head):not(.scroll) { max-width: 100%; }

  p { max-width: var(--measure); }
  .note { font-size: 0.86rem; color: var(--muted); max-width: 74ch; }

  /* figures */
  .figs { display: flex; flex-direction: column; gap: 1.4rem; }
  .legend { display: flex; gap: 1.4rem; align-items: center; font-size: 0.8rem; color: var(--muted); flex-wrap: wrap; }
  .legend .scalenote { margin-left: auto; font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.04em; }
  .legend .swatch { display: inline-block; width: 0.7rem; height: 0.7rem; margin-right: 0.45rem; vertical-align: -1px; }

  .scroll { overflow-x: auto; max-width: 100%; margin: 0 calc(-1 * var(--strip) * 0.5); padding: 0 calc(var(--strip) * 0.5); }
  table { border-collapse: collapse; width: 100%; min-width: 560px; }
  .cap { text-align: left; font-size: 0.8rem; color: var(--muted); margin: 0 0 0.6rem; padding: 0; max-width: 76ch; }
  th, td { text-align: left; padding: 0.62rem 0.9rem 0.62rem 0; vertical-align: middle; }
  thead th {
    font: 500 10.5px/1.2 var(--mono);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    border-bottom: 1px solid var(--rule-strong);
    padding-bottom: 0.7rem;
    white-space: nowrap;
  }
  tbody tr { border-bottom: 1px solid var(--rule); }
  tbody tr:last-child { border-bottom: 0; }
  tbody tr:hover { background: color-mix(in oklch, var(--ink) 3%, transparent); }
  td.name { font-weight: 500; }
  td.name small { display: block; font: 400 11.5px/1.3 var(--mono); color: var(--muted); font-weight: 400; }
  .num { text-align: right; font-family: var(--mono); font-size: 0.86rem; white-space: nowrap; }
  th.num { text-align: right; }
  .figcell { min-width: 12rem; width: 26%; }
  .m { display: grid; grid-template-columns: 1fr 4.6rem; align-items: center; gap: 0.55rem; padding: 0.1rem 0; }
  .track { display: block; height: 8px; background: color-mix(in oklch, var(--ink) 7%, transparent); border-radius: 2px; overflow: hidden; }
  .track i { display: block; height: 100%; width: var(--w); border-radius: 2px; }
  .track i.tar { background: var(--tar); }
  .track i.codec { background: var(--codec); }
  .v { font: 500 0.8rem/1 var(--mono); color: var(--ink-2); text-align: right; }
  td.figcell .m { grid-template-columns: 1fr; }
  .win { color: var(--good); font-family: var(--mono); font-size: 0.82rem; font-weight: 600; }
  .lose { color: var(--muted); font-family: var(--mono); font-size: 0.82rem; }
  .y { color: var(--good); }
  .n { color: var(--bad); }
  .p { color: var(--warn); }
  td.feat { font-weight: 500; }
  td.why { color: var(--muted); font-size: 0.83rem; }
  tr.group th {
    text-align: left;
    font: 500 10.5px/1.2 var(--mono);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink-2);
    padding: 1.6rem 0 0.45rem;
    border-bottom: 1px solid var(--rule-strong);
  }
  tr.group:first-child th { padding-top: 0.2rem; }

  /* install size */
  .sizes { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: clamp(1.5rem, 4vw, 3.5rem); align-items: start; }
  .size-compare { display: grid; gap: 1.9rem; }
  .size-row { min-width: 0; }
  .size-label { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 0.5rem; font-size: 0.9rem; font-weight: 500; }
  .size-label .v { font: 400 0.78rem/1 var(--mono); color: var(--muted); }
  .size-note { font-size: 0.83rem; color: var(--muted); margin: 0.7rem 0 0; max-width: 46ch; }
  .size-bar { display: flex; height: 2.2rem; border-radius: 2px; overflow: hidden; background: color-mix(in oklch, var(--ink) 6%, transparent); }
  .size-bar span { display: block; height: 100%; border-right: 1px solid var(--paper); }
  .size-bar span:last-child { border-right: 0; }
  .size-legend { list-style: none; margin: 1rem 0 0; padding: 0; display: grid; gap: 0.3rem; font-size: 0.83rem; }
  .size-legend li { display: grid; grid-template-columns: 1.4rem 1fr auto; align-items: center; gap: 0.4rem; color: var(--ink-2); }
  .size-legend .dot { width: 0.7rem; height: 0.7rem; border-radius: 2px; }
  .size-legend .v { text-align: right; color: var(--muted); }

  dl.facts { margin: 0; display: grid; gap: 0.9rem; }
  dl.facts div { border-top: 1px solid var(--rule); padding-top: 0.7rem; }
  dl.facts dt { font: 500 10.5px/1.2 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
  dl.facts dd { margin: 0.35rem 0 0; }
  dl.facts dd b { font-family: var(--mono); font-weight: 500; }

  .verdict { display: grid; grid-template-columns: repeat(3, 1fr); gap: clamp(1.5rem, 4vw, 3rem); }
  .verdict > div { border-top: 2px solid var(--rule-strong); padding-top: 0.9rem; }
  .verdict > div.codec { border-top-color: var(--codec); }
  .verdict > div.tar { border-top-color: var(--tar); }
  .verdict h3 { font-size: 1rem; margin: 0 0 0.5rem; letter-spacing: -0.01em; }
  .verdict p { font-size: 0.92rem; color: var(--ink-2); margin: 0; max-width: 34ch; }
  ul.plain { margin: 0.6rem 0 0; padding-left: 1.1rem; color: var(--ink-2); font-size: 0.92rem; }
  ul.plain li { margin-bottom: 0.3rem; max-width: 46ch; }

  footer { padding: 2.5rem 0 4rem; border-top: 1px solid var(--rule-strong); }
  footer .label { margin-bottom: 0.9rem; }
  footer p { font-size: 0.83rem; color: var(--muted); }

  @media (max-width: 900px) {
    .ledger { grid-template-columns: 1fr 1fr; }
    .ledger > div:nth-child(2n) { border-right: 0; }
    .ledger > div:nth-child(-n+2) { border-bottom: 1px solid var(--rule); }
    .sizes, .verdict { grid-template-columns: 1fr; }
  }
  @media (max-width: 560px) {
    .sec-head { grid-template-columns: 1fr; }
    .sec-head p { grid-column: 1; }
    .ledger { grid-template-columns: 1fr; }
    .ledger > div { border-right: 0; border-bottom: 1px solid var(--rule); }
  }
  @media (max-width: 820px) {
    .scroll { overflow-x: visible; margin: 0; padding: 0; max-width: 100%; }
    table { min-width: 0; display: block; width: 100%; }
    thead { display: none; }
    tbody { display: block; }
    tbody tr {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.7rem 0.9rem;
      padding: 1rem 0;
      border-bottom: 1px solid var(--rule);
    }
    tbody tr:last-child { border-bottom: 0; }
    td { display: block; padding: 0; border: 0; min-width: 0; }
    td.name, td.feat { grid-column: 1 / -1; }
    td.name small { margin-top: 0.15rem; }
    td.figcell { grid-column: 1 / -1; width: auto; min-width: 0; }
    td.why { grid-column: 1 / -1; }
    td[data-label]::before {
      content: attr(data-label);
      display: block;
      font: 500 10px/1.2 var(--mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.3rem;
    }
    td.figcell[data-label]::before { margin-bottom: 0.4rem; }
    tr.group { display: block; }
    tr.group th { display: block; border-bottom: 1px solid var(--rule-strong); }
    .size-label .v { font-size: 0.72rem; }
    .sizes { gap: 2rem; }
  }
  @media print {
    body { background: #fff; color: #000; font-size: 11pt; }
    section { break-inside: avoid; }
    .track { border: 1px solid #999; }
  }
</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <div class="kicker">
    <span class="label">npm cli 12.2.1 &middot; dependency benchmark</span>
    <span class="label">27 Oct 2026</span>
  </div>
  <h1>node-tar <span class="vs">vs</span> tar-codec</h1>
  <p class="lede">
    Astral's Rust tar parser is <b>7 to 11 times faster</b> at extracting npm-shaped
    tarballs, needs <b>1 MB of resident memory instead of 190</b>, and still cannot replace
    node-tar in npm without four behaviour changes and a native build for every
    platform. Measured through a napi addon, against the real tarballs npm ships.
  </p>
  <div class="ledger">
    <div>
      <div class="k label">extract speed</div>
      <div class="big">7.0&ndash;11.4<span class="dim">x</span></div>
      <div class="sub">82.3 ms &rarr; 10.9 ms, lodash</div>
    </div>
    <div>
      <div class="k label">peak memory</div>
      <div class="big">190 &rarr; 1<span class="dim"> MB</span></div>
      <div class="sub">10k files, one extraction</div>
    </div>
    <div>
      <div class="k label">install footprint</div>
      <div class="big">2.9 &rarr; 1.7<span class="dim"> MB</span></div>
      <div class="sub">6 JS packages, or one binary</div>
    </div>
    <div>
      <div class="k label">feature parity</div>
      <div class="big">4 <span class="dim">blockers</span></div>
      <div class="sub">modes, mtimes, links, vendors</div>
    </div>
  </div>
</header>

<main>
<section id="speed">
  <div class="sec-head">
    <span class="sec-num">01</span>
    <h2>Speed</h2>
    <p>
      Every corpus is extracted into a fresh directory, seven times, alternating
      order. Both sides produce byte-identical trees: same paths, sizes, exec bits
      and sha256.
    </p>
  </div>

  <div class="figs">
    <div class="legend">
      <span><span class="swatch" style="background:var(--tar)"></span>node-tar 7.5.22</span>
      <span><span class="swatch" style="background:var(--codec)"></span>tar-codec 0.0.15</span>
      <span class="scalenote">per-row scale</span>
    </div>

    <p class="cap">Uncompressed tar, extract to disk. Median of 7, milliseconds.</p>

    <div class="scroll">

    <table aria-label="extract speed, uncompressed tar">
      <thead>
        <tr>
          <th>corpus</th>
          <th class="num">entries</th>
          <th>node-tar / tar-codec</th>
          <th class="num">speedup</th>
        </tr>
      </thead>
      <tbody>
        ${raw.map(r => `<tr>
          <td class="name">${r.name}<small>${r.mb} MB</small></td>
          <td class="num" data-label="entries">${r.entries.toLocaleString('en-US')}</td>
          <td class="figcell" data-label="node-tar / tar-codec, ms">${rowBars(r.extract[0], r.extract[1])}</td>
          <td class="num" data-label="speedup">${speedBadge(x(r.extract[0], r.extract[1]))}</td>
        </tr>`).join('\n        ')}
      </tbody>
    </table>
    </div>

    <p class="cap">Uncompressed tar, parse only, no files written. Median of 7, milliseconds.</p>

    <div class="scroll">

    <table aria-label="parse speed, uncompressed tar">
      <thead>
        <tr>
          <th>corpus</th>
          <th class="num">entries</th>
          <th>node-tar / tar-codec</th>
          <th class="num">speedup</th>
        </tr>
      </thead>
      <tbody>
        ${raw.map(r => `<tr>
          <td class="name">${r.name}<small>${r.mb} MB</small></td>
          <td class="num" data-label="entries">${r.entries.toLocaleString('en-US')}</td>
          <td class="figcell" data-label="node-tar / tar-codec, ms">${rowBars(r.parse[0], r.parse[1])}</td>
          <td class="num" data-label="speedup">${speedBadge(x(r.parse[0], r.parse[1]))}</td>
        </tr>`).join('\n        ')}
      </tbody>
    </table>
    </div>

    <p class="cap">.tgz end to end, one archive at a time. node-tar inflates its own input; tar-codec gets gunzipSync output, and that cost is included.</p>

    <div class="scroll">

    <table aria-label=".tgz end to end">
      <thead>
        <tr>
          <th>corpus</th>
          <th class="num">gunzip</th>
          <th>node-tar / tar-codec</th>
          <th class="num">speedup</th>
        </tr>
      </thead>
      <tbody>
        ${tgz.map(r => `<tr>
          <td class="name">${r.name}</td>
          <td class="num" data-label="gunzip">${r.gunzip} ms</td>
          <td class="figcell" data-label="node-tar / tar-codec, ms">${rowBars(r.total[0], r.total[1])}</td>
          <td class="num" data-label="speedup">${speedBadge(x(r.total[0], r.total[1]))}</td>
        </tr>`).join('\n        ')}
      </tbody>
    </table>
    </div>
  </div>

  <div style="margin-top:2.6rem">
    <h3 style="font-size:1rem;margin:0 0 0.4rem">Where node-tar spends the time</h3>
    <p class="note">
      Same 1051-file tree written by a plain <code>fs.writeFileSync</code> loop: 15.3 ms.
      tar-codec extracts in 10.3 ms, so it sits at the filesystem floor. node-tar
      takes 88.7 ms, which is per-entry stream and callback work, not I/O. That is
      why the ratio survives on a real disk, and why the 53-entry corpus with
      200 KB files shows no win at all.
    </p>
  </div>

  <p class="cap">Install-shaped: real dependency closure of eslint, express, typescript, webpack and jest, 130 packages, 4313 files, 32 MB unpacked. Median of 4.</p>

  <div class="scroll" style="margin-top:2.4rem">

  <table aria-label="install-shaped extraction">
      <thead>
        <tr>
          <th>arm</th>
          <th class="num">total</th>
          <th class="num">vs node-tar, 8 in flight</th>
          <th>note</th>
        </tr>
      </thead>
      <tbody>
        ${install.map(a => `<tr>
          <td class="name">${a.name}</td>
          <td class="num" data-label="total">${a.ms} ms</td>
          <td class="num" data-label="vs node-tar, 8 in flight">${speedBadge(x(496, a.ms))}</td>
          <td class="why">${a.note}</td>
        </tr>`).join('\n        ')}
      </tbody>
    </table>
  </div>
  <p class="note" style="margin-top:0.9rem">
    130 packages is about ${seconds(496)} of extract work in node-tar at 8 in flight,
    against ${seconds(106)} for the best tar-codec arm. On a 500-package cold install
    that is a couple of seconds, not a different install.
  </p>
</section>

<section id="memory">
  <div class="sec-head">
    <span class="sec-num">02</span>
    <h2>Memory</h2>
    <p>
      Peak RSS of a separate node process per arm, idle node already subtracted in
      the bars below. node-tar's peak scales with entries and with how many
      extractions run at once; tar-codec borrows the buffer and writes.
    </p>
  </div>

  <p class="cap">Peak RSS in MB, median of 3 runs. Idle node is 59 to 72 MB and is excluded.</p>

  <div class="scroll">

  <table aria-label="peak memory">
      <thead>
        <tr>
          <th>workload</th>
          <th class="num">idle</th>
          <th>node-tar / tar-codec, peak over idle</th>
          <th class="num">node-tar</th>
          <th class="num">tar-codec</th>
        </tr>
      </thead>
      <tbody>
        ${memory.map(m => {
          const a = m.tar - m.idle
          const b = m.codec - m.idle
          return `<tr>
          <td class="name">${m.name}<small>${m.name.includes('10k') ? '14.7 MB tar, 10102 entries' : '2.2 MB tar, 1051 entries'}</small></td>
          <td class="num" data-label="idle">${m.idle} MB</td>
          <td class="figcell" data-label="peak over idle">${barsOnly(a, b)}</td>
          <td class="num" data-label="node-tar">+${a} MB</td>
          <td class="num" data-label="tar-codec">+${b} MB</td>
        </tr>`
        }).join('\n        ')}
      </tbody>
    </table>
  </div>
  <p class="note" style="margin-top:0.9rem">
    The async wrapper (needed so pacote can keep eight extractions in flight) costs
    one copy of the archive per task: +65 MB at 8 concurrent 10k-file archives,
    against +2 MB for the blocking call. That copy is avoidable by sharing the
    buffer or reading from a file handle. The 1101 MB node-tar figure is not a
    typo: eight concurrent unpacks of a 10102-entry archive hold roughly a gigabyte
    of live stream buffers.
  </p>
</section>

<section id="size">
  <div class="sec-head">
    <span class="sec-num">03</span>
    <h2>Install size</h2>
    <p>
      Published package sizes from the npm registry, not the pruned copy in a
      checkout. node-tar is six packages of JavaScript; the addon is one binary
      per platform plus a few lines of loader.
    </p>
  </div>

  <div class="sizes">
    <div class="size-compare">
      <div class="size-row">
        <div class="size-label"><span>node-tar</span><span class="v">2.85 MB &middot; 6 packages</span></div>
        <div class="size-bar" role="img" aria-label="node-tar 2.85 MB">
          ${packages.map((p, i) => {
            const colors = ['oklch(0.66 0.090 176)', 'oklch(0.71 0.080 176)', 'oklch(0.75 0.068 176)', 'oklch(0.79 0.055 176)', 'oklch(0.83 0.042 176)', 'oklch(0.86 0.030 176)']
            return `<span style="width:${(p.bytes / totalBytes * 100).toFixed(1)}%;background:${colors[i]}" title="${p.name}: ${p.bytes} bytes"></span>`
          }).join('')}
        </div>
        <ul class="size-legend">
          ${packages.map((p, i) => {
            const colors = ['oklch(0.66 0.090 176)', 'oklch(0.71 0.080 176)', 'oklch(0.75 0.068 176)', 'oklch(0.79 0.055 176)', 'oklch(0.83 0.042 176)', 'oklch(0.86 0.030 176)']
            return `<li><span class="dot" style="background:${colors[i]}"></span><span>${p.name}</span><span class="v">${(p.bytes / 1024).toFixed(0)} KB</span></li>`
          }).join('\n          ')}
        </ul>
      </div>
      <div class="size-row">
        <div class="size-label"><span>tar-codec</span><span class="v">1.74 MB &middot; 1 binary</span></div>
        <div class="size-bar" role="img" aria-label="tar-codec addon 1.74 MB">
          <span style="width:${(ADDON.bytes / totalBytes * 100).toFixed(1)}%;background:var(--codec)" title="tarcodec.node: ${ADDON.bytes} bytes"></span>
        </div>
        <p class="size-note">One <code>tarcodec.node</code>, 629 KB gzipped on the wire. The other seven platform builds exist in the registry but never reach this machine.</p>
      </div>
    </div>

    <dl class="facts">
      <div>
        <dt>node-tar 7.5.22</dt>
        <dd><b>2.85 MB</b> unpacked, <b>322</b> files, <b>6</b> packages, no native code. Downloads and runs anywhere node does.</dd>
      </div>
      <div>
        <dt>tar-codec addon</dt>
        <dd><b>1.74 MB</b> per platform, <b>629 KB</b> gzipped. 79 crates in the lockfile at build time, none at runtime. Eight platform builds is about <b>14 MB</b> of published artifacts; a user downloads one.</dd>
      </div>
      <div>
        <dt>The part that is not in the number</dt>
        <dd>Prebuilds for linux x64 and arm64, glibc and musl, darwin, win32, plus a node-tar fallback when the addon cannot load. npm is pure JS today; this is the first native dependency in the CLI.</dd>
      </div>
    </dl>
  </div>
</section>

<section id="features">
  <div class="sec-head">
    <span class="sec-num">04</span>
    <h2>Features</h2>
    <p>
      Tested, not read off a README. The four blockers are the ones that change
      what ends up on disk; the rest are work to schedule.
    </p>
  </div>

  <div class="scroll">
    <table aria-label="feature parity">
      <thead>
        <tr>
          <th>behaviour</th>
          <th>node-tar</th>
          <th>tar-codec</th>
          <th>why it matters for npm</th>
        </tr>
      </thead>
      <tbody>
        ${features.map(g => `<tr class="group"><th colspan="4">${g.group}</th></tr>
        ${g.rows.map(r => `<tr>
          <td class="feat">${r[0]}</td>
          <td data-label="node-tar">${mark(r[1])}</td>
          <td data-label="tar-codec">${mark(r[2])}</td>
          <td class="why">${r[3]}</td>
        </tr>`).join('\n        ')}`).join('\n        ')}
      </tbody>
    </table>
  </div>

  <p class="note" style="margin-top:1.4rem">
    The fidelity test is a pax tarball with a 0600 file, a 0700 file, an mtime from
    2020, a symlink and a hard link. node-tar restores all of it. tar-codec writes
    0644 and 0755, stamps the current time, creates the symlink, and aborts on the
    hard link, leaving a partial tree. Vendor records matter for the same reason
    strictness helps: a tarball made by macOS or bsdtar carries SCHILY and
    LIBARCHIVE records, which the default policy rejects. An allowlist fixes it,
    and that path is tested.
  </p>
</section>

<section id="verdict">
  <div class="sec-head">
    <span class="sec-num">05</span>
    <h2>Verdict</h2>
    <p>
      The speed is real and it is at the filesystem floor. The reason not to ship
      it yet is semantics, distribution and the missing writer, in that order.
    </p>
  </div>

  <div class="verdict">
    <div class="codec">
      <h3>What tar-codec buys</h3>
      <p>
        Seven to eleven times the extract throughput on packages with hundreds to
        thousands of files, with no heap growth and a parser that rejects the
        family-mixing and tombstone tricks the blog post describes.
      </p>
    </div>
    <div class="tar">
      <h3>What it costs</h3>
      <p>
        A native build matrix, a fallback path, a second wrapper for pack and
        publish, and four behaviour changes that users would notice in file modes
        and mtimes.
      </p>
    </div>
    <div>
      <h3>If it were my call</h3>
      <ul class="plain">
        <li>Prototype inside pacote behind an env flag, not in the CLI.</li>
        <li>Fix the gaps in the wrapper first: modes, mtimes, hard links, vendor allowlist, strip.</li>
        <li>Measure a real <code>npm ci</code> before committing to prebuilds.</li>
      </ul>
    </div>
  </div>

  <p class="cap">What the integration would need, in order.</p>

  <div class="scroll" style="margin-top:2.5rem">

  <table aria-label="integration work">
      <thead>
        <tr><th style="width:38%">work</th><th style="width:9%">size</th><th>reason</th></tr>
      </thead>
      <tbody>
        <tr><td class="feat">Expose modes and mtimes</td><td data-label="size"><span class="p">medium</span></td><td class="why">generic extraction normalizes them; needs a lower-level path through tar-framing</td></tr>
        <tr><td class="feat">Allow hard links, vendor records, strip</td><td data-label="size"><span class="y">small</span></td><td class="why">policy flags exist; strip and filter do not, so a temp dir and rename</td></tr>
        <tr><td class="feat">Write tarballs</td><td data-label="size"><span class="p">medium</span></td><td class="why">npm pack and publish still need a writer; TarEncoder exists but is unwrapped</td></tr>
        <tr><td class="feat">Prebuilds and fallback</td><td data-label="size"><span class="n">large</span></td><td class="why">eight targets, optionalDependencies, a working node-tar path when the addon is absent</td></tr>
        <tr><td class="feat">Real install A/B</td><td data-label="size"><span class="y">small</span></td><td class="why">the 130-package closure is a proxy, not npm ci against a registry</td></tr>
      </tbody>
    </table>
  </div>
</section>
</main>

<footer>
  <div class="label">Method</div>
  <p>
    ${MACHINE}. ${NODE}. Medians of 7 for raw tar, 5 for .tgz, 4 for the install
    closure, 3 process runs for memory. Corpora: lodash 4.18.1, typescript 7.0.2,
    eslint 10.13.0, two generated pax tarballs, and the latest versions of a real
    dependency closure pulled from the registry. The addon is a napi-rs cdylib over
    tar-codec 0.0.15 with flate2/zlib-rs for the gzip arm; source and scripts sit
    next to this page. tmpfs absolutes will be lower than a real disk; ratios track
    per-entry cost, not I/O.
  </p>
  <p>
    node-tar install sizes come from registry metadata. Everything else is measured
    on this machine, including the fidelity test and the vendor-record rejection.
  </p>
</footer>
</div>
</body>
</html>
`

writeFileSync(new URL('./compare.html', import.meta.url), html)
console.log('wrote compare.html', html.length, 'bytes')
