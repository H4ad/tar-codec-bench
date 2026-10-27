# tar-codec vs node-tar, measured

A napi-rs wrapper around [astral's tar-codec](https://astral.sh/blog/tar-codec) and
the benchmarks used to compare it with the tar implementation npm ships today
(node-tar 7.5.22), on real npm tarballs and in the shape pacote uses them.

The short version: extraction is 7 to 11 times faster, peak memory goes from
hundreds of megabytes to about one, and tar-codec still cannot replace node-tar
inside npm without four behaviour changes and a native build for every platform.

Full write-up with charts: https://pr-docs.viniciusl.com.br/npm-cli-tar-codec/
(or open `compare.html` locally).

## Numbers

Raw tar, 7 runs, median, Ryzen 9 5950X, tmpfs, node 24.20.0:

| corpus | entries | extract node-tar | extract tar-codec | parse node-tar | parse tar-codec |
| --- | --- | --- | --- | --- | --- |
| lodash | 1051 | 82.3 ms | 10.9 ms | 9.04 ms | 1.29 ms |
| typescript | 416 | 54.7 ms | 6.14 ms | 2.45 ms | 0.76 ms |
| eslint | 421 | 49.5 ms | 7.12 ms | 2.30 ms | 0.74 ms |
| 10k synthetic files | 10102 | 1113.6 ms | 97.8 ms | 55.5 ms | 9.71 ms |
| 50 x 200 KB | 53 | 6.95 ms | 6.54 ms | 0.39 ms | 0.70 ms |

Install-shaped, 130 real packages, 4313 files, 32 MB unpacked: 496 ms for
node-tar with 8 extractions in flight against 106 ms for tar-codec with zlib-rs
inflating inside the addon.

Peak RSS over an idle node process: +189 MB for node-tar and +2 MB for tar-codec
on a single 10102-entry archive; +1029 MB against +1 MB with eight running at
once.

Published size: node-tar plus its five dependencies is 2.99 MB across 322 files;
the addon is 1.83 MB per platform, 644 KB gzipped.

## Layout

| path | what it is |
| --- | --- |
| `rust/` | napi addon over tar-codec 0.0.15: `extract`, `extractAsync`, `extractGz`, `extractGzAsync`, `list` |
| `bench.js` | raw tar parse and extract, per corpus |
| `bench-e2e.js` | `.tgz` end to end, one at a time and 24 at once |
| `bench-install.js` | install-shaped run over a real dependency closure |
| `mem.js`, `mem-driver.js` | peak RSS per arm, one process each |
| `verify.js` | compares both extractors byte for byte (path, size, exec bit, sha256) |
| `fidelity.js` | modes, mtimes, symlinks, hard links, against a hand-built pax tarball |
| `floor.js` | raw `fs.writeFileSync` floor for the same tree |
| `gen.js`, `fetch-corpus.js` | build the synthetic and registry corpora |
| `fetch-tree.js` | resolve and download a real 150-package closure |
| `page.mjs` | generates `compare.html` from the measured numbers |

## Reproduce

Requires node 20+, Rust 1.85+ (the addon uses edition 2024) and a C toolchain for
napi. Tested on Linux x64; macOS should work through the same script, Windows is
untested.

```bash
npm install
npm run build      # cargo build --release, copies the cdylib to ./tarcodec.node
npm run corpus     # downloads lodash, typescript, eslint and builds two synthetic tarballs
npm run bench
npm run bench:tgz
npm run bench:memory
npm run verify
npm run fidelity
npm run page       # regenerates compare.html
```

`npm run bench:install` additionally downloads around 180 MB of tarballs for the
150-package closure before running; skip it if you only want the per-archive
numbers.

## Method and caveats

- Extraction always goes to a fresh directory, and both sides are verified to
  produce identical trees before their times are compared.
- Everything runs on tmpfs, so the absolute times are lower than a real disk.
  `floor.js` shows tar-codec at the filesystem floor (10.3 ms against a 15.3 ms
  plain write loop for the same 1051 files), so the ratio comes from per-entry
  work in node-tar, not from I/O.
- node-tar is measured both one at a time and with 8 in flight, because pacote
  extracts concurrently. A blocking napi call would negate that, which is why the
  wrapper also exposes `AsyncTask` variants.
- The async variant copies the archive per task, so its memory numbers are worse
  than the blocking call. That copy is avoidable by sharing the buffer or reading
  from a file handle.

## What would break in npm

Measured with `fidelity.js`, not read off a README:

- file modes are normalized to 0644 and 0755 (only executable intent survives)
- mtimes are not restored
- hard links are rejected by default
- pax vendor records (`SCHILY.*`, `LIBARCHIVE.*`) are rejected by default, and
  macOS/bsdtar archives carry them

Also missing for a drop-in: `strip: 1`, the `filter` callback, `mode` in the
member metadata, and a writer, so `npm pack` would still need node-tar or a second
wrapper around `TarEncoder`.

## License

MIT. tar-codec is MIT or Apache-2.0, node-tar is ISC.
