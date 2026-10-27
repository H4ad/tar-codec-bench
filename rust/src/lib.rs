//! Minimal napi wrapper around astral's tar-codec, for benchmarking against node-tar.
//!
//! Exposes:
//!   extract(buffer, dest, allowOverwrites?, ignoreVendors?) -> 0
//!   extractAsync(...) -> Promise<0>  (runs on a libuv worker)
//!   list(buffer, ignoreVendors?) -> [{ path, size, mode, kind }]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tar_codec::extract::ExtractPolicy;
use tar_codec::{
    Archive, DecodePolicy, Member, MemberPayload, PaxDecodePolicy, PaxVendorExtensionPolicy,
    TarArchive,
};

fn rt() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| Error::from_reason(format!("runtime: {e}")))
}

fn policy(ignore_vendors: bool) -> DecodePolicy {
    let mut pax = PaxDecodePolicy::default();
    if ignore_vendors {
        // bsdtar/libarchive and macOS tar emit SCHILY.*/LIBARCHIVE.* records.
        pax = pax.vendor_extension_policy(PaxVendorExtensionPolicy::ignore([
            "SCHILY", "LIBARCHIVE",
        ]));
    }
    DecodePolicy::default().pax_policy(pax)
}

#[napi(object)]
pub struct Entry {
    pub path: String,
    pub size: f64,
    pub mode: f64,
    pub kind: String,
}

#[napi]
pub fn extract(
    buf: Buffer,
    dest: String,
    allow_overwrites: Option<bool>,
    ignore_vendors: Option<bool>,
) -> Result<u32> {
    let rt = rt()?;
    let data: &[u8] = &buf;
    let decode = policy(ignore_vendors.unwrap_or(false));
    rt.block_on(async move {
        let extract = ExtractPolicy::default().allow_overwrites(allow_overwrites.unwrap_or(true));
        TarArchive::new(data)
            .with_policy(decode)
            .extract_in(std::path::Path::new(&dest), extract)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))
    })?;
    Ok(0)
}

pub struct ExtractTask {
    data: Vec<u8>,
    dest: String,
    allow_overwrites: bool,
    ignore_vendors: bool,
    gzip: bool,
}

fn flate(data: &[u8], gzip: bool) -> Result<Vec<u8>> {
    if !gzip {
        return Ok(data.to_vec());
    }
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|e| Error::from_reason(format!("gunzip: {e}")))?;
    Ok(out)
}

#[napi]
impl Task for ExtractTask {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        let rt = rt()?;
        let raw = flate(&self.data, self.gzip)?;
        let data: &[u8] = &raw;
        let dest = self.dest.clone();
        let allow = self.allow_overwrites;
        let decode = policy(self.ignore_vendors);
        rt.block_on(async move {
            let extract = ExtractPolicy::default().allow_overwrites(allow);
            TarArchive::new(data)
                .with_policy(decode)
                .extract_in(std::path::Path::new(&dest), extract)
                .await
                .map_err(|e| Error::from_reason(format!("{e}")))
        })?;
        Ok(0)
    }

    fn resolve(&mut self, _env: Env, output: Self::JsValue) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Extracts a gzip-compressed tarball, inflating with zlib-rs inside the addon.
#[napi]
pub fn extract_gz(
    buf: Buffer,
    dest: String,
    allow_overwrites: Option<bool>,
    ignore_vendors: Option<bool>,
) -> Result<u32> {
    let rt = rt()?;
    let raw = flate(&buf, true)?;
    let data: &[u8] = &raw;
    let decode = policy(ignore_vendors.unwrap_or(false));
    rt.block_on(async move {
        let extract = ExtractPolicy::default().allow_overwrites(allow_overwrites.unwrap_or(true));
        TarArchive::new(data)
            .with_policy(decode)
            .extract_in(std::path::Path::new(&dest), extract)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))
    })?;
    Ok(0)
}

/// Same as `extract_gz`, on a libuv worker thread.
#[napi]
pub fn extract_gz_async(
    buf: Buffer,
    dest: String,
    allow_overwrites: Option<bool>,
    ignore_vendors: Option<bool>,
) -> AsyncTask<ExtractTask> {
    AsyncTask::new(ExtractTask {
        data: buf.to_vec(),
        dest,
        allow_overwrites: allow_overwrites.unwrap_or(true),
        ignore_vendors: ignore_vendors.unwrap_or(false),
        gzip: true,
    })
}

/// Same as `extract`, but runs on a libuv worker thread so several archives can
/// be extracted concurrently, the way pacote does during an install.
#[napi]
pub fn extract_async(
    buf: Buffer,
    dest: String,
    allow_overwrites: Option<bool>,
    ignore_vendors: Option<bool>,
) -> AsyncTask<ExtractTask> {
    AsyncTask::new(ExtractTask {
        data: buf.to_vec(),
        dest,
        allow_overwrites: allow_overwrites.unwrap_or(true),
        ignore_vendors: ignore_vendors.unwrap_or(false),
        gzip: false,
    })
}

#[napi]
pub fn list(buf: Buffer, ignore_vendors: Option<bool>) -> Result<Vec<Entry>> {
    let rt = rt()?;
    let data: &[u8] = &buf;
    let decode = policy(ignore_vendors.unwrap_or(false));
    rt.block_on(async move {
        let mut members = TarArchive::new(data).with_policy(decode).members();
        let mut out = Vec::new();
        while let Some(member) = members
            .next()
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?
        {
            let path = member.metadata().path.clone();
            let (size, mode, kind) = match member {
                Member::File {
                    size,
                    executable,
                    payload,
                    ..
                } => {
                    payload
                        .skip()
                        .await
                        .map_err(|e| Error::from_reason(format!("{e}")))?;
                    (size, if executable { 0o755 } else { 0o644 }, "file")
                }
                Member::HardLink { size, payload, .. } => {
                    payload
                        .skip()
                        .await
                        .map_err(|e| Error::from_reason(format!("{e}")))?;
                    (size, 0o644, "hardlink")
                }
                Member::Directory { .. } => (0, 0o755, "dir"),
                Member::SymbolicLink { .. } => (0, 0o777, "symlink"),
                Member::Special { .. } => (0, 0o644, "special"),
            };
            out.push(Entry {
                path,
                size: size as f64,
                mode: mode as f64,
                kind: kind.to_string(),
            });
        }
        Ok(out)
    })
}
