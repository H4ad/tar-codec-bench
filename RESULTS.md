# tar-codec vs node-tar in npm

Quick benchmark of replacing `tar` (node-tar 7.5.x, what npm 12.2.1 ships) with
astral's [`tar-codec`](https://crates.io/crates/tar-codec) 0.0.15 behind a
napi-rs addon.

Machine: desk, Ryzen 9 5950X, 32 threads, tmpfs (/tmp), Linux x64, node v24.20.0.

## Wrapper

`rust/` is a napi-rs cdylib (79 crates, 1.7 MB `.so`). Exposed functions:

| function | what it does |
| --- | --- |
| `list(buf, ignoreVendors)` | decode members, `skip()` payloads, return `{path,size,mode,kind}` |
| `extract(buf, dest, overwrite, ignoreVendors)` | `TarArchive::extract_in` on the calling thread |
| `extractAsync(...)` | same on a libuv worker (`AsyncTask`) so pacote-style concurrency works |
| `extractGz[Async](...)` | inflate with `flate2`/zlib-rs inside the addon, then extract |

`js/tarcodec.node` is the build; `require` it directly, napi-rs registers itself.

## Correctness

`verify.js` extracts with both and compares every path, size, exec bit and
sha256. Identical for lodash, typescript, eslint and both synthetic corpora
(1051 / 434 / 443 / 10102 / 53 entries).

## Raw tar, no compression (7 reps, median)

| corpus | size | entries | parse node-tar | parse codec | extract node-tar | extract codec |
| --- | --- | --- | --- | --- | --- | --- |
| lodash | 2.2 MB | 1051 | 9.0 ms | 1.3 ms (7.0x) | 82 ms | 11 ms (7.6x) |
| typescript | 2.7 MB | 416 | 2.5 ms | 0.8 ms (3.2x) | 55 ms | 6.1 ms (8.9x) |
| eslint | 3.1 MB | 421 | 2.3 ms | 0.7 ms (3.1x) | 50 ms | 7.1 ms (7.0x) |
| synthetic 10k small | 14.7 MB | 10102 | 56 ms | 9.7 ms (5.7x) | 1114 ms | 98 ms (11.4x) |
| synthetic 50 x 200 KB | 9.8 MB | 53 | 0.39 ms | 0.70 ms (0.56x) | 7.0 ms | 6.5 ms (1.1x) |

Few large files: no win. Many small entries: 7 to 11x.

## Where node-tar's time goes

Fresh dir, 1051 file lodash tree, same files written by hand with
`fs.writeFileSync`:

| | ms |
| --- | --- |
| node-tar `x` | 89 |
| tar-codec `extract_in` | 10 |
| raw fs loop, same paths and sizes | 15 |

tar-codec is at the filesystem floor; node-tar's cost is per-entry JS/stream
work, so the win is not a tmpfs artifact.

## .tgz, single archive

node-tar takes the `.tgz` directly; tar-codec gets `gunzipSync` output.

| corpus | node-tar | gunzip | gunzip+codec | speedup |
| --- | --- | --- | --- | --- |
| lodash | 89 ms | 2.5 | 13.0 ms | 6.9x |
| typescript | 60 ms | 2.9 | 8.7 ms | 6.9x |
| eslint | 62 ms | 4.6 | 11.2 ms | 5.5x |
| 10k small | 1112 ms | 29 | 124 ms | 9.0x |

## Install-shaped: 130 packages, 4313 files

Real dependency closure of eslint/express/typescript/webpack/jest pulled from the
registry (`corpus/deps.json`). 7 MB of .tgz, 32 MB unpacked. All arms verified to
produce the same 4313 files.

| arm | total | vs node-tar serial | vs node-tar, 8 in flight |
| --- | --- | --- | --- |
| node-tar, serial | 741 ms | 1.00x | |
| node-tar, 8 in flight | 496 ms | 1.49x | 1.00x |
| codec, JS gunzip, serial | 172 ms | 4.32x | 2.89x |
| codec, async zlib, 8 | 155 ms | 4.78x | 3.20x |
| codec, zlib-rs in addon, serial | 213 ms | 3.48x | 2.33x |
| codec, zlib-rs in addon, 8 | 106 ms | 6.98x | 4.67x |

Same closure including the 20 `@typescript/typescript-*` platform binaries npm
would skip (177 of its 184 MB, 563 MB unpacked, 6589 files): node-tar 2696 ms
serial / 1883 ms at 8, best codec arm 814 ms. Compression dominates there, so
the end-to-end win shrinks to 2.3x.

## Fidelity gaps (this is the blocker, not speed)

`fidelity.js` builds a pax tar with 0600 and 0700 files, an mtime, a symlink and
a hard link:

| | node-tar | tar-codec `extract_in` |
| --- | --- | --- |
| mode 0600 / 0700 | preserved | normalized to 0644 / 0755 (exec bit only) |
| mtime | preserved | set to now |
| symlink | preserved | preserved |
| hard link | created | rejected by default, aborts mid-extract |
| pax vendor records (`SCHILY`, `LIBARCHIVE`) | ignored | rejected by default |

Vendor records are the likely breakage: macOS/`bsdtar` tarballs carry them.
`PaxVendorExtensionPolicy::ignore(["SCHILY","LIBARCHIVE"])` fixes it (tested).

Also missing for a drop-in: `strip: 1` (pacote always strips `package/`),
the `filter` hook, mode in the member API (`Member` exposes only an `executable`
bool, so `lib/utils/tar.js`'s `getContents` cannot report `mode` without
dropping to `tar-framing`), and a writer (`npm pack`/`publish` still need
node-tar or a second wrapper around `TarEncoder`/`Builder`).

## Shipping cost

npm is pure JS today. A native addon means prebuilt binaries for every platform
npm supports (linux x64/arm64 glibc and musl, darwin x64/arm64, win32
x64/arm64), optionalDependencies per platform like esbuild/sharp, and a
node-tar fallback when the addon fails to load.

## Reproduce

```
node bench.js 7            # raw tar, parse and extract
node bench-e2e.js 5        # .tgz, single and 24 in flight
node bench-install.js 4    # install-shaped closure
node floor.js              # fs write floor
node verify.js lodash typescript eslint many-small few-large
node fidelity.js           # modes, mtimes, links
```

## Peak memory

Peak RSS of a separate node process per arm, median of 3 runs, idle node
(59 to 72 MB) excluded. Same corpora as above.

| workload | node-tar | tar-codec (blocking) | tar-codec (async) |
| --- | --- | --- | --- |
| lodash, 1051 entries, 5 extractions | +58 MB | +2 MB | +16 MB |
| 10k files, 2 extractions | +189 MB | +2 MB | +32 MB |
| lodash, 8 concurrent | +244 MB | +2 MB | +14 MB |
| 10k files, 8 concurrent | +1029 MB | +1 MB | +65 MB |

The async arm copies the archive per task (`AsyncTask` needs owned data); the
blocking call borrows the buffer. node-tar's peak is live stream buffers per
open member, so it scales with entries times concurrency.

## Install size

Published package sizes from the registry, not a pruned checkout.

| | packages | files | bytes |
| --- | --- | --- | --- |
| node-tar 7.5.22 + deps | 6 | 322 | 2.99 MB unpacked |
| tar-codec addon, one platform | 1 | 1 binary | 1.83 MB (644 KB gzipped) |

node-tar deps: minipass 367 KB, minizlib 118 KB, @isaacs/fs-minipass 101 KB,
yallist 80 KB, chownr 22 KB. The addon's 79 crates exist only at build time.

## Page

`compare.html` is generated by `page.mjs` from the numbers above. Open it
directly, it has no external assets.
