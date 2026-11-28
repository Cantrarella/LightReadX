//! CBR (RAR 漫画包) → CBZ, 桌面原生实现.
//!
//! 以前每次打开 CBR 都在 WebView 里用 unrar wasm 解出全部图片, 再用 fflate 重新压缩成 CBZ 交给 foliate。
//! 现在桌面第一次打开时由 Rust (UnRAR, 与 node-unrar-js 同源的 RARLAB 代码) 解包, 按原顺序写成 store 模式
//! CBZ 缓存在书库 `books/<id>.cbr.cbz`, 之后直接读缓存。移动端 / 网页版仍走 src/services/comic.ts。
//! 收取图片与可选的 ComicInfo.xml; 若 ComicInfo.xml 损坏则自动回退到仅图片路径; 加密、图片损坏或没有可读图片时报错。

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::{Path, PathBuf};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::backup_zip::{write_zip, Source};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::http_upload::{resolve_library_file, FileRef};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const IMAGE_EXTS: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// 与前端 comicMeta.ts 的 isComicImagePath 一致（不含 svg / jxl）
pub fn is_image(name: &str) -> bool {
  name.rsplit_once('.').is_some_and(|(_, ext)| IMAGE_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext)))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// 判断是否为 ComicInfo.xml（忽略大小写，支持包内子目录）
pub fn is_comic_info(name: &str) -> bool {
  name
    .rsplit(['/', '\\'])
    .next()
    .unwrap_or(name)
    .eq_ignore_ascii_case("comicinfo.xml")
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// 包内路径改成 ZIP 可用的相对路径: `\` → `/`, 去掉空段 / `.` / `..`
fn zip_name(name: &str) -> Option<String> {
  let parts: Vec<&str> = name.split(['/', '\\']).filter(|s| !s.is_empty() && *s != "." && *s != "..").collect();
  (!parts.is_empty()).then(|| parts.join("/"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// 解出 `src` 里满足 `keep` 的文件 (按包内顺序), 写成 store 模式 ZIP 到 `dest`; 返回收进去的文件数.
/// 先写 `<dest>.part` 再改名, 失败删除半截文件. 与 Tauri 无关, 便于单测.
pub fn rar_to_zip(src: &Path, dest: &Path, keep: impl Fn(&str) -> bool) -> Result<usize, String> {
  let bad = |e: unrar::error::UnrarError| format!("archive: {e}");
  let mut archive = unrar::Archive::new(src).open_for_processing().map_err(bad)?;
  let mut entries = Vec::new();
  let mut seen = std::collections::HashSet::new();
  while let Some(header) = archive.read_header().map_err(bad)? {
    let entry = header.entry();
    let name = entry.filename.to_string_lossy().into_owned();
    archive = match (entry.is_file() && keep(&name), zip_name(&name)) {
      (true, Some(zip)) if seen.insert(zip.clone()) => {
        let (data, next) = header.read().map_err(bad)?;
        entries.push((zip, Source::Bytes(data)));
        next
      }
      _ => header.skip().map_err(bad)?,
    };
  }
  if entries.is_empty() {
    return Err("archive: RAR 包中没有找到可用的文件 (或文件已加密)".into());
  }
  let count = entries.len();
  let mut part = dest.as_os_str().to_owned();
  part.push(".part");
  let part = PathBuf::from(part);
  let result = std::fs::File::create(&part)
    .map_err(|e| format!("file: {e}"))
    .and_then(|file| write_zip(file, entries, u32::MAX as u64, |_| {}))
    .and_then(|_| std::fs::rename(&part, dest).map_err(|e| format!("file: {e}")));
  if let Err(e) = result {
    let _ = std::fs::remove_file(&part);
    return Err(e);
  }
  Ok(count)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// 解出 RAR 中的图片与可选的 ComicInfo.xml 写成 store 模式 CBZ。
/// 若读取 ComicInfo.xml 遇到 CRC 或解压错误，通过仅图片路径 `rar_to_zip(src, dest, is_image)` 重新打开原始 RAR 并转换；
/// 图片本身损坏、没有可读图片或整个包无法解密时继续报错且不留半截文件。
pub fn rar_to_cbz(src: &Path, dest: &Path) -> Result<usize, String> {
  let bad = |e: unrar::error::UnrarError| format!("archive: {e}");
  let mut archive = unrar::Archive::new(src).open_for_processing().map_err(bad)?;
  let mut entries = Vec::new();
  let mut seen = std::collections::HashSet::new();
  let mut image_count = 0usize;
  while let Some(header) = archive.read_header().map_err(bad)? {
    let entry = header.entry();
    let name = entry.filename.to_string_lossy().into_owned();
    let img = is_image(&name);
    let xml = !img && is_comic_info(&name);
    let keep = entry.is_file() && (img || xml);
    archive = match (keep, zip_name(&name)) {
      (true, Some(zip)) if seen.insert(zip.clone()) => match header.read() {
        Ok((data, next)) => {
          if img {
            image_count += 1;
          }
          entries.push((zip, Source::Bytes(data)));
          next
        }
        Err(_) if xml => return rar_to_zip(src, dest, is_image),
        Err(e) => return Err(bad(e)),
      },
      _ => header.skip().map_err(bad)?,
    };
  }
  if image_count == 0 {
    return Err("archive: RAR 包中没有找到可用的文件 (或文件已加密)".into());
  }
  let count = entries.len();
  let mut part = dest.as_os_str().to_owned();
  part.push(".part");
  let part = PathBuf::from(part);
  let result = std::fs::File::create(&part)
    .map_err(|e| format!("file: {e}"))
    .and_then(|file| write_zip(file, entries, u32::MAX as u64, |_| {}))
    .and_then(|_| std::fs::rename(&part, dest).map_err(|e| format!("file: {e}")));
  if let Err(e) = result {
    let _ = std::fs::remove_file(&part);
    return Err(e);
  }
  Ok(count)
}

/// 书库里的 CBR (`rel`) 转成 CBZ 缓存 (`cache_rel`); 缓存已存在且不比原文件旧时直接复用. 返回缓存大小.
#[tauri::command]
pub async fn comic_cbr_cache<R: tauri::Runtime>(
  app: tauri::AppHandle<R>,
  root: String,
  rel: String,
  cache_rel: String,
) -> Result<u64, String> {
  #[cfg(any(target_os = "android", target_os = "ios"))]
  {
    let _ = (app, root, rel, cache_rel);
    Err("unsupported: 移动端用前端 unrar wasm".to_string())
  }
  #[cfg(not(any(target_os = "android", target_os = "ios")))]
  {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().ok();
    let src = resolve_library_file(app_data.clone(), &FileRef { root: root.clone(), rel })?;
    let dest = resolve_library_file(app_data, &FileRef { root, rel: cache_rel })?;
    tauri::async_runtime::spawn_blocking(move || {
      let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
      if let (Some(cached), Some(original)) = (modified(&dest), modified(&src)) {
        if cached >= original {
          return std::fs::metadata(&dest).map(|m| m.len()).map_err(|e| format!("file: {e}"));
        }
      }
      rar_to_cbz(&src, &dest)?;
      std::fs::metadata(&dest).map(|m| m.len()).map_err(|e| format!("file: {e}"))
    })
    .await
    .map_err(|e| format!("file: {e}"))?
  }
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
  use super::*;

  /// 测试样本取自 unrar crate 0.5.8 的 data/ (MIT, 见 testdata/unrar-fixtures-LICENSE-MIT.txt)
  fn fixture(name: &str, bytes: &[u8]) -> PathBuf {
    let p = std::env::temp_dir().join(format!("lr-comic-{}-{name}", std::process::id()));
    std::fs::write(&p, bytes).unwrap();
    p
  }

  fn zip_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
    let mut f = std::fs::File::open(path).unwrap();
    let entries = crate::backup_zip::read_central(&mut f).unwrap();
    entries
      .iter()
      .map(|e| {
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut crate::backup_zip::open_entry(&mut f, e).unwrap(), &mut data).unwrap();
        (e.name.clone(), data)
      })
      .collect()
  }

  #[test]
  fn converts_solid_and_unicode_archives() {
    for (name, bytes, want) in [
      ("solid.rar", &include_bytes!("testdata/unrar-solid.rar")[..], ".gitignore"),
      ("unicode.rar", &include_bytes!("testdata/unrar-unicode-entry.rar")[..], "unicodefilename❤\u{fe0f}.txt"),
    ] {
      let src = fixture(name, bytes);
      let dest = src.with_extension("cbz");
      // 样本里没有图片: 收全部文件来验证解包与写包
      assert_eq!(rar_to_zip(&src, &dest, |_| true).unwrap(), 1);
      let entries = zip_entries(&dest);
      assert_eq!(entries[0].0, want);
      assert!(!entries[0].1.is_empty());
      assert!(!dest.with_extension("cbz.part").exists());
      // 只收图片时没有可用文件 → 报错且不留半截文件
      let dest2 = src.with_extension("img.cbz");
      assert!(rar_to_zip(&src, &dest2, is_image).unwrap_err().starts_with("archive:"));
      assert!(!dest2.exists());
      for p in [src, dest] {
        std::fs::remove_file(p).unwrap();
      }
    }
  }

  #[test]
  fn encrypted_archive_fails_cleanly() {
    let src = fixture("crypted.rar", include_bytes!("testdata/unrar-crypted.rar"));
    let dest = src.with_extension("cbz");
    assert!(rar_to_zip(&src, &dest, |_| true).is_err());
    assert!(!dest.exists());
    std::fs::remove_file(src).unwrap();
  }

  #[test]
  fn image_filter_and_names_match_frontend_rules() {
    for ok in ["a.JPG", "dir/b.jpeg", "c.png", "001.PNG", "d.webp", "e.avif", "f.gif", "g.bmp"] {
      assert!(is_image(ok), "{ok}");
    }
    for no in ["a.txt", "jpg", "cover.jpg.zip", "noext", "page.svg", "PAGE.SVG", "page.jxl", "PAGE.JXL"] {
      assert!(!is_image(no), "{no}");
    }
    assert_eq!(zip_name("ch1\\001.jpg").as_deref(), Some("ch1/001.jpg"));
    assert_eq!(zip_name("/../x/./y.png").as_deref(), Some("x/y.png"));
    assert_eq!(zip_name("../.."), None);
    assert!(is_comic_info("ComicInfo.xml"));
    assert!(is_comic_info("sub\\comicinfo.XML"));
    assert!(!is_comic_info("ComicInfo.xml.bak"));
  }

  /// 构造 store 模式 RAR4，支持对指定条目注入损坏的 CRC-32（测试元数据或图片 CRC 损坏）
  fn build_store_rar4_with_crc(files: &[(&str, &[u8], bool)]) -> Vec<u8> {
    let mut out = vec![0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00];
    // Archive header (HEAD_TYPE = 0x73)
    let arch_body = [0x73u8, 0x00, 0x00, 0x0D, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    let arch_crc = (crc32fast::hash(&arch_body) & 0xFFFF) as u16;
    out.extend_from_slice(&arch_crc.to_le_bytes());
    out.extend_from_slice(&arch_body);

    for &(name, data, corrupt_crc) in files {
      let name_bytes = name.as_bytes();
      let head_size = (32 + name_bytes.len()) as u16;
      let pack_size = data.len() as u32;
      let mut file_crc = crc32fast::hash(data);
      if corrupt_crc {
        file_crc ^= 0xDEAD_BEEF;
      }
      let mut body = Vec::with_capacity(30 + name_bytes.len());
      body.push(0x74); // HEAD_TYPE = file header
      body.extend_from_slice(&0x8000u16.to_le_bytes()); // HEAD_FLAGS = LONG_BLOCK
      body.extend_from_slice(&head_size.to_le_bytes());
      body.extend_from_slice(&pack_size.to_le_bytes());
      body.extend_from_slice(&pack_size.to_le_bytes());
      body.push(2); // HOST_OS = Win32
      body.extend_from_slice(&file_crc.to_le_bytes());
      body.extend_from_slice(&0u32.to_le_bytes()); // FTIME
      body.push(20); // UNP_VER
      body.push(0x30); // METHOD = store
      body.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
      body.extend_from_slice(&0x20u32.to_le_bytes()); // ATTR
      body.extend_from_slice(name_bytes);
      let head_crc = (crc32fast::hash(&body) & 0xFFFF) as u16;
      out.extend_from_slice(&head_crc.to_le_bytes());
      out.extend_from_slice(&body);
      out.extend_from_slice(data);
    }

    let end_body = [0x7Bu8, 0x00, 0x40, 0x07, 0x00];
    let end_crc = (crc32fast::hash(&end_body) & 0xFFFF) as u16;
    out.extend_from_slice(&end_crc.to_le_bytes());
    out.extend_from_slice(&end_body);
    out
  }

  fn build_store_rar4(files: &[(&str, &[u8])]) -> Vec<u8> {
    let entries: Vec<(&str, &[u8], bool)> = files.iter().map(|&(n, d)| (n, d, false)).collect();
    build_store_rar4_with_crc(&entries)
  }

  #[test]
  fn rar_to_cbz_preserves_comic_info_xml_and_requires_at_least_one_image() {
    let xml = b"<?xml version=\"1.0\" encoding=\"utf-8\"?><ComicInfo><Title>\xe9\x95\x96\xe4\xba\xba \xe7\xac\xac\xe4\xb8\x80\xe5\x8d\xb7</Title></ComicInfo>";
    let png = b"\x89PNG\r\n\x1a\nfake-image";
    let rar = build_store_rar4(&[("sub\\ComicInfo.xml", xml), ("001.png", png), ("notes.txt", b"skip")]);
    let src = fixture("with-comicinfo.cbr", &rar);
    let dest = src.with_extension("cbz");
    assert_eq!(rar_to_cbz(&src, &dest).unwrap(), 2);
    let entries = zip_entries(&dest);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].0, "sub/ComicInfo.xml");
    assert_eq!(entries[0].1, xml);
    assert_eq!(entries[1].0, "001.png");
    assert_eq!(entries[1].1, png);
    std::fs::remove_file(&src).unwrap();
    std::fs::remove_file(&dest).unwrap();

    // 只有 ComicInfo.xml 没有图片时仍应报错拒绝
    let only_xml_rar = build_store_rar4(&[("ComicInfo.xml", xml)]);
    let src_no_img = fixture("only-xml.cbr", &only_xml_rar);
    let dest_no_img = src_no_img.with_extension("cbz");
    assert!(rar_to_cbz(&src_no_img, &dest_no_img).is_err());
    assert!(!dest_no_img.exists());
    std::fs::remove_file(&src_no_img).unwrap();

    // UTF-16LE / UTF-16BE 带 BOM 的 ComicInfo.xml 原始字节在 CBR -> CBZ 缓存中应原样保留
    for (label, bom_and_body) in [
      ("utf16le", vec![0xFFu8, 0xFE, b'<', 0x00, b'C', 0x00, b'/', 0x00, b'>', 0x00]),
      ("utf16be", vec![0xFEu8, 0xFF, 0x00, b'<', 0x00, b'C', 0x00, b'/', 0x00, b'>']),
    ] {
      let rar_u16 = build_store_rar4(&[("ComicInfo.xml", &bom_and_body), ("001.PNG", png)]);
      let src_u16 = fixture(&format!("{label}.cbr"), &rar_u16);
      let dest_u16 = src_u16.with_extension("cbz");
      assert_eq!(rar_to_cbz(&src_u16, &dest_u16).unwrap(), 2);
      let entries_u16 = zip_entries(&dest_u16);
      assert_eq!(entries_u16[0].0, "ComicInfo.xml");
      assert_eq!(entries_u16[0].1, bom_and_body);
      assert_eq!(entries_u16[1].0, "001.PNG");
      std::fs::remove_file(&src_u16).unwrap();
      std::fs::remove_file(&dest_u16).unwrap();
    }
  }

  #[test]
  fn rar_to_cbz_falls_back_to_images_when_comic_info_crc_is_corrupt_and_fails_when_image_is_corrupt() {
    let xml = b"<?xml version=\"1.0\" encoding=\"utf-8\"?><ComicInfo><Title>Broken CRC XML</Title></ComicInfo>";
    let png1 = b"\x89PNG\r\n\x1a\npage-1";
    let png2 = b"\x89PNG\r\n\x1a\npage-2";

    // 1. 仅 ComicInfo.xml 条目 CRC 损坏，图片完好：应回退到仅图片路径并产出可读 CBZ
    let rar_bad_xml = build_store_rar4_with_crc(&[
      ("ComicInfo.xml", xml, true),
      ("001.png", png1, false),
      ("002.png", png2, false),
    ]);
    let src_bad_xml = fixture("bad-xml-crc.cbr", &rar_bad_xml);
    let dest_bad_xml = src_bad_xml.with_extension("cbz");
    assert_eq!(rar_to_cbz(&src_bad_xml, &dest_bad_xml).unwrap(), 2);
    let entries = zip_entries(&dest_bad_xml);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].0, "001.png");
    assert_eq!(entries[0].1, png1);
    assert_eq!(entries[1].0, "002.png");
    assert_eq!(entries[1].1, png2);
    std::fs::remove_file(&src_bad_xml).unwrap();
    std::fs::remove_file(&dest_bad_xml).unwrap();

    // 2. 图片本身 CRC 损坏：必须继续报错且不留半截文件
    let rar_bad_img = build_store_rar4_with_crc(&[
      ("ComicInfo.xml", xml, false),
      ("001.png", png1, true),
    ]);
    let src_bad_img = fixture("bad-img-crc.cbr", &rar_bad_img);
    let dest_bad_img = src_bad_img.with_extension("cbz");
    assert!(rar_to_cbz(&src_bad_img, &dest_bad_img).is_err());
    assert!(!dest_bad_img.exists());
    std::fs::remove_file(&src_bad_img).unwrap();

    // 3. ComicInfo.xml 损坏且无任何可读图片（例如只有 SVG/JXL）：回退后仍报错
    let rar_bad_xml_no_img = build_store_rar4_with_crc(&[
      ("ComicInfo.xml", xml, true),
      ("001.svg", b"<svg></svg>", false),
      ("002.jxl", b"fake-jxl", false),
    ]);
    let src_no_img = fixture("bad-xml-no-img.cbr", &rar_bad_xml_no_img);
    let dest_no_img = src_no_img.with_extension("cbz");
    assert!(rar_to_cbz(&src_no_img, &dest_no_img).is_err());
    assert!(!dest_no_img.exists());
    std::fs::remove_file(&src_no_img).unwrap();
  }
}
