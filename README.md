# tar-codec vs node-tar, measured

A napi-rs wrapper around [astral's tar-codec](https://astral.sh/blog/tar-codec) and
the benchmarks used to compare it with the tar implementation npm ships today
(node-tar 7.5.22), on real npm tarballs and in the shape pacote uses them.

The short version: once both sides restore file modes and mtimes, extraction is
5.3 to 7.8 times faster on archives with hundreds to thousands of entries, and
4.2 times faster end to end on an install-shaped run. If tar-codec's own output
semantics are accepted (modes normalized, mtimes not restored) the raw extract
ratio is 7.6 to 10.7 times on tmpfs. Peak memory is +2 MB against +191 MB for one
10k-entry archive, and +183 MB against +1028 MB with eight in flight. tar-codec
still cannot replace node-tar inside npm without eight gaps and a native build
for every platform.

Full write-up with charts: https://pr-docs.viniciusl.com.br/npm-cli-tar-codec/
(or open `compare.html` locally).

## Numbers

Raw tar, 7 runs, median, Ryzen 9 5950X, tmpfs work dir, node 24.20.0. The
"matched" columns force node-tar to skip mode and mtime restore
(`noChmod`, `noMtime`) and give tar-codec a pass that restores both, so the
comparison is the same job:

| corpus | entries | extract node-tar | extract tar-codec | ratio | matched node-tar | matched tar-codec | matched ratio |
| --- | --- | --- | --- | --- | --- | --- | --- |
| lodash | 1051 | 78.9 ms | 10.3 ms | 7.6x | 77.2 ms | 14.7 ms | 5.3x |
| typescript | 416 | 52.1 ms | 5.88 ms | 8.9x | 50.1 ms | 7.59 ms | 6.6x |
| eslint | 421 | 48.8 ms | 6.06 ms | 8.0x | 47.8 ms | 7.85 ms | 6.1x |
| 10k synthetic files | 10102 | 967.3 ms | 90.8 ms | 10.7x | 987.4 ms | 126.8 ms | 7.8x |
| 50 x 200 KB | 53 | 5.38 ms | 5.32 ms | 1.0x | 5.48 ms | 5.22 ms | 1.0x |

Parse only (`list`, no files written), same runs:

| corpus | node-tar | tar-codec | ratio |
| --- | --- | --- | --- |
| lodash | 5.41 ms | 1.18 ms | 4.6x |
| typescript | 1.96 ms | 0.57 ms | 3.4x |
| eslint | 2.02 ms | 0.63 ms | 3.2x |
| 10k synthetic files | 47.8 ms | 8.99 ms | 5.3x |

`tar-codec 0.0.15` exposes neither mode nor mtime, so the matched codec arm reads
them from node-tar's listing and applies them in JS. That makes its cost an upper
bound; a Rust-side pass through `tar-framing` would be cheaper.

Install-shaped, 130 real packages, 4313 files, 32 MB unpacked, median of 4:
322 ms for node-tar with 8 extractions in flight against 76 ms for tar-codec with
zlib-rs inflating inside the addon (4.24x). Every arm writes the same paths and
bytes, checked against the tar-1 tree on each run.

.tgz end to end, one archive at a time, median of 5: lodash 85.9 against 13.5 ms,
typescript 53.3 against 8.4 ms, eslint 57.6 against 10.3 ms, 10k synthetic 995.8
against 117.3 ms. 24 archives started at once: 863.3 against 68.9 ms (12.5x) with
gzip inside the addon. Pre-inflating the input for the codec arm would report
15.1x, which is why that arm is not the one quoted.

Peak RSS over an idle node process, median of 3 process runs:

| workload | idle | node-tar | tar-codec |
| --- | --- | --- | --- |
| lodash, 5 extractions | 59 MB | +55 MB | +2 MB |
| 10k files, 2 extractions | 72 MB | +191 MB | +2 MB |
| lodash.tgz, 5 extractions | 57 MB | +59 MB | +6 MB |
| lodash, 8 concurrent | 60 MB | +225 MB | +31 MB (async) |
| 10k files, 8 concurrent | 72 MB | +1028 MB | +183 MB (async) |

The concurrent rows have to use the async arm: a blocking napi call cannot
overlap, so eight of them run one after another. The blocking call peaks at
+2 MB, but it serializes the install. The async variant copies the archive per
task (retained +66 MB on the 10k row after the directories are removed), and that
copy is avoidable by sharing the buffer or reading from a file handle.

Published size: node-tar plus its five dependencies is 2.99 MB across 322 files;
the addon is 1.83 MB per platform, 644 KB gzipped.

## Layout

| path | what it is |
| --- | --- |
| `rust/` | napi addon over tar-codec 0.0.15: `extract`, `extractAsync`, `extractGz`, `extractGzAsync`, `list` |
| `lib/` | work dir on tmpfs, tree comparison, results JSON writer |
| `bench.js` | raw tar parse and extract, four arms including the fidelity-matched pair |
| `bench-e2e.js` | `.tgz` end to end, one at a time and 24 at once, gzip counted on both sides |
| `bench-install.js` | install-shaped run over a real dependency closure, strip parity and tree check |
| `mem.js`, `mem-driver.js` | peak RSS per arm, one process each |
| `verify.js` | compares both extractors byte for byte (path, size, exec bit, sha256) and checks the mode/mtime pass |
| `fidelity.js` | modes, mtimes, symlinks, hard links, against a hand-built pax tarball |
| `floor.js` | raw `fs.writeFileSync` floor for the same tree |
| `gen.js`, `fetch-corpus.js` | build the synthetic corpora, fetch pinned registry tarballs |
| `fetch-tree.js` | resolve and download a real 150-package closure |
| `results/` | the measurements, one JSON per benchmark; `compare.html` is generated from these |
| `page.mjs` | generates `compare.html` from `results/*.json` |

## Reproduce

Requires node 20+, Rust 1.85+ (the addon uses edition 2024) and a C toolchain for
napi. Tested on Linux x64; macOS should work through the same script, Windows is
untested.

```bash
npm install
npm run build            # cargo build --release, copies the cdylib to ./tarcodec.node
npm run corpus           # pinned lodash/typescript/eslint, plus synthetic .tar and .tar.gz
npm run corpus:install   # 184 MB of closure tarballs, only needed for bench:install
npm run bench
npm run bench:tgz
npm run bench:install
npm run bench:memory
npm run bench:floor
npm run verify
npm run page             # regenerates compare.html from results/
```

`npm run all` runs the set except `corpus` and `corpus:install`.

## Method and caveats

- Scratch work goes to `os.tmpdir()`, which is tmpfs on Linux, never into the
  repo. Set `TAR_BENCH_WORK` to a directory on a real disk to measure that
  instead. In an earlier run with the same code on btrfs, lodash went from 79.2
  against 10.1 ms (7.8x) here to 98.7 against 23.3 ms (4.2x), because tar-codec
  runs at the write floor and node-tar does not.
- `bench.js` extracts both sides into fresh directories and compares path, size,
  exec bit and sha256 before the timed loop. `verify.js` runs the same check
  standalone and also compares the modes and mtimes of the metadata arm against
  node-tar (0 differences on all five corpora). The install benchmark also
  asserts every arm produces the tar-1 tree, not just a matching file count.
- The four extraction arms are node-tar defaults, node-tar with
  `noChmod`/`noMtime`, tar-codec, and tar-codec plus the metadata pass. The two
  ratios are reported separately because they answer different questions.
- node-tar is measured one at a time and with 8 in flight, because pacote
  extracts concurrently. A blocking napi call negates that, which is why the
  wrapper exposes `AsyncTask` variants and the memory chart uses them for the
  concurrent rows.
- Every number in `compare.html` is read from `results/*.json`. Nothing measured
  is typed into the page by hand, and `npm run page` fails if any result file is
  missing.
- `bench-install` strips `package/` from the codec arms with a staging dir and a
  rename, since tar-codec has no strip option. Not every npm tarball uses
  `package/` (`@types/estree` uses `estree/`), so the wrapper takes whatever
  single root the archive has.

## What would break in npm

Measured with `fidelity.js`, not read off a README:

- file modes are normalized to 0644 and 0755 (only executable intent survives)
- mtimes are not restored
- hard links are rejected by default
- pax vendor records (`SCHILY.*`, `LIBARCHIVE.*`) are rejected by default, and
  macOS/bsdtar archives carry them

Also missing for a drop-in: `strip: 1`, the `filter` callback, `mode` in the
member metadata, and a writer, so `npm pack` would still need node-tar or a
second wrapper around `TarEncoder`. That is four fidelity gaps plus four API
gaps, not four in total.

## License

MIT. tar-codec is MIT or Apache-2.0, node-tar is ISC.
