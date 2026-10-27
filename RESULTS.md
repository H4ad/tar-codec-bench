# tar-codec vs node-tar in npm

Quick benchmark of replacing `tar` (node-tar 7.5.x, what npm 12.2.1 ships) with
astral's [`tar-codec`](https://crates.io/crates/tar-codec) 0.0.15 behind a
napi-rs addon.

Machine: desk, Ryzen 9 5950X, 32 threads, work dir on tmpfs (`os.tmpdir()`),
Linux x64, node v24.20.0. Set `TAR_BENCH_WORK` to measure a real disk instead.

## Wrapper

`rust/` is a napi-rs cdylib (79 crates, 1.83 MB `.so`). Exposed functions:

| function | what it does |
| --- | --- |
| `list(buf, ignoreVendors)` | decode members, `skip()` payloads, return `{path,size,mode,kind}` |
| `extract(buf, dest, overwrite, ignoreVendors)` | `TarArchive::extract_in` on the calling thread |
| `extractAsync(...)` | same on a libuv worker (`AsyncTask`) so pacote-style concurrency works |
| `extractGz[Async](...)` | inflate with `flate2`/zlib-rs inside the addon, then extract |

`tarcodec.node` is the build; `require` it directly, napi-rs registers itself.

## Correctness

`verify.js` extracts with both and compares every path, size, exec bit and
sha256. Identical for lodash, typescript, eslint and both synthetic corpora
(1053 / 434 / 443 / 10102 / 53 entries, 0 differences). The metadata arm is
checked the same way against node-tar's modes and mtimes, also 0 differences.
`bench.js` runs the content check before timing, and `bench-install.js` asserts
that every arm writes the tar-1 tree.

## Raw tar, no compression (7 reps, median)

| corpus | entries | parse node-tar | parse codec | extract node-tar | extract codec | ratio | matched node-tar | matched codec | matched ratio |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lodash | 1051 | 5.41 ms | 1.18 ms | 78.9 ms | 10.3 ms | 7.6x | 77.2 ms | 14.7 ms | 5.3x |
| typescript | 416 | 1.96 ms | 0.57 ms | 52.1 ms | 5.88 ms | 8.9x | 50.1 ms | 7.59 ms | 6.6x |
| eslint | 421 | 2.02 ms | 0.63 ms | 48.8 ms | 6.06 ms | 8.0x | 47.8 ms | 7.85 ms | 6.1x |
| 10k synthetic | 10102 | 47.8 ms | 8.99 ms | 967.3 ms | 90.8 ms | 10.7x | 987.4 ms | 126.8 ms | 7.8x |
| 50 x 200 KB | 53 | 0.27 ms | 0.32 ms | 5.38 ms | 5.32 ms | 1.0x | 5.48 ms | 5.22 ms | 1.0x |

The matched pair is the fair comparison: node-tar skips mode and mtime restore
(`noChmod`, `noMtime`), and tar-codec gets a JS pass that restores both. The 4.4
ms that pass costs on lodash is an upper bound, because tar-codec 0.0.15 exposes
neither mode nor mtime and the values have to come from node-tar's listing.

Few large files: no win either way. Many small entries: 7.6 to 10.7x raw, 5.3 to
7.8x with metadata restored.

## Where node-tar's time goes

Fresh dir, 1051 file lodash tree, same files written by hand with
`fs.writeFileSync`:

| | ms |
| --- | --- |
| node-tar `x` | 79.2 |
| tar-codec `extract_in` | 10.1 |
| raw fs loop, same paths and sizes | 14.7 |

tar-codec is at the filesystem floor, so node-tar's cost is per-entry JS/stream
work. The flip side is that the ratio depends on the destination: on a btrfs work
dir the same comparison was 98.7 against 23.3 ms (4.2x). `TAR_BENCH_WORK` selects
the directory.

## .tgz, single archive

node-tar takes the `.tgz` directly; tar-codec gets `gunzipSync` output, and that
cost is included.

| corpus | node-tar | gunzip | gunzip+codec | codec total | speedup |
| --- | --- | --- | --- | --- | --- |
| lodash | 85.9 ms | 2.9 | 10.6 ms | 13.5 ms | 6.4x |
| typescript | 53.3 ms | 2.7 | 5.8 ms | 8.4 ms | 6.3x |
| eslint | 57.6 ms | 4.1 | 6.3 ms | 10.3 ms | 5.6x |
| 10k small | 995.8 ms | 27.6 | 89.8 ms | 117.3 ms | 8.5x |

24 archives started at once: node-tar 863.3 ms, tar-codec 68.9 ms with gzip
inside the addon (12.5x). A pre-inflated input buffer would report 15.1x; that
arm is kept in the output only to show what skipping inflate buys, not as the
result.

## Install-shaped: 130 packages, 4313 files

Real dependency closure of eslint/express/typescript/webpack/jest pulled from the
registry (`corpus/deps.json`). 7 MB of .tgz, 32 MB unpacked. All arms verify the
same 4313 files and the same paths and bytes as tar-1.

| arm | total | vs node-tar serial | vs node-tar, 8 in flight |
| --- | --- | --- | --- |
| node-tar, serial | 470 ms | 1.00x | |
| node-tar, 8 in flight | 322 ms | 1.46x | 1.00x |
| codec, JS gunzip, serial | 143 ms | 3.29x | 2.25x |
| codec, async zlib, 8 | 93 ms | 5.06x | 3.47x |
| codec, zlib-rs in addon, serial | 145 ms | 3.24x | 2.22x |
| codec, zlib-rs in addon, 8 | 76 ms | 6.19x | 4.24x |

tar-codec has no `strip`, so the codec arms extract into a staging dir and rename
the archive root into place; that cost is inside the timed region. The wrapper
takes whatever single root the tarball has, since not every package uses
`package/`.

`ALL=1 node bench-install.js` runs the unfiltered closure including the 20
`@typescript/typescript-*` platform binaries npm would not install. Those are
compression-bound and not a real install, so their numbers are not quoted here.

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

Also missing for a drop-in: `strip: 1` (pacote always strips the archive root),
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
node bench.js 7            # raw tar, parse and extract, four arms
node bench-e2e.js 5        # .tgz, single and 24 in flight
node bench-install.js 4    # install-shaped closure (needs corpus:install)
node mem-driver.js         # peak RSS per arm
node floor.js              # fs write floor
node verify.js lodash typescript eslint many-small few-large
node fidelity.js           # modes, mtimes, links
node page.mjs              # regenerate compare.html from results/*.json
```

Every script writes `results/<name>.json`, and `page.mjs` reads those files
instead of embedded numbers.

## Peak memory

Peak RSS of a separate node process per arm, median of 3 runs, idle node (57 to
72 MB) excluded. The concurrent rows use the async arm, because the blocking
call cannot overlap.

| workload | node-tar | tar-codec (blocking) | tar-codec (async) |
| --- | --- | --- | --- |
| lodash, 1051 entries, 5 extractions | +55 MB | +2 MB | +17 MB |
| 10k files, 2 extractions | +191 MB | +2 MB | +32 MB |
| lodash.tgz, 5 extractions | +59 MB | +6 MB (gz) | +19 MB (gz) |
| lodash, 8 concurrent | +225 MB | +2 MB | +31 MB |
| 10k files, 8 concurrent | +1028 MB | +2 MB | +183 MB |

The async arm copies the archive per task (`AsyncTask` needs owned data); the
blocking call borrows the buffer. node-tar's peak is live stream buffers per open
member, so it scales with entries times concurrency. On the last row the async
arm retains +66 MB after the directories are removed, against +2 MB for the
blocking call.

## Install size

Published package sizes from the registry, not a pruned checkout.

| | packages | files | bytes |
| --- | --- | --- | --- |
| node-tar 7.5.22 + deps | 6 | 322 | 2.99 MB unpacked |
| tar-codec addon, one platform | 1 | 1 binary | 1.83 MB (644 KB gzipped) |

node-tar deps: minipass 367 KB, minizlib 118 KB, @isaacs/fs-minipass 101 KB,
yallist 80 KB, chownr 22 KB. The addon's 79 crates exist only at build time.

## Page

`compare.html` is generated by `page.mjs` from `results/*.json`. Open it
directly, it has no external assets.
