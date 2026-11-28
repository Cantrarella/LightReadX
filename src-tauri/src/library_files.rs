//! 同步用的书库文件命令: 算指纹、下载、改名、删除, 书的内容都不经过 WebView.
//!
//! 安卓上 plugin-fs / plugin-http 把文件内容经 IPC 搬进 JS (postMessage 通道上是 JSON 数字数组),
//! 几十 MB 的书就会把 WebView 内存撑爆 (同步时卡死、闪退). 这里改为:
//!  - `library_file_sha256`: 流式读盘算 SHA-256, 内存占用与文件大小无关;
//!  - `library_file_download`: 流式下载到书库里的暂存文件 (`books/<名字>`), 边下边算 SHA-256,
//!    前端比对后再 `library_file_rename` 成正式文件, 不通过则 `library_file_remove`.
//!  - `library_file_write_chunk`: 导入时 WebView 里的书 (只有 File 对象, 没有路径) 分块以 base64 传入
//!    追加写盘. 一次性 `writeFile` 会把整本书变成 JSON 数字数组, 40 MB 的 PDF 就能让平板卡死闪退 (issue #14).
//!  - `library_migrate`: 换书库文件夹时整库复制 (数据库 + 书 + 封面), 用 `std::fs::copy`
//!    (系统可用 copy_file_range / clonefile), 只经 Channel 回报进度, 字节不进 WebView.
//! 路径规则与上传命令相同 (见 http_upload.rs 的 `resolve_library_file`): 只能是书库的
//! `books/<文件名>` / `covers/<文件名>`. 错误字符串以 `timeout:` / `network:` / `file:` / `request:` 前缀区分.

use std::{
  collections::BTreeMap,
  io::{Read, Seek, SeekFrom, Write},
  path::Path,
  time::Duration,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::http_upload::{build_client, map_err, resolve_library_file, FileRef, UploadSpec};
use tauri::ipc::Channel;

/// 下载整体上限 (与前端 DOWNLOAD_TIMEOUT_MS 一致)
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// 连续这么久收不到数据视为卡住
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, PartialEq)]
pub struct DownloadResult {
  pub status: u16,
  /// 下载成功 (2xx) 时为文件的 SHA-256 十六进制, 否则为空
  pub sha256: String,
  pub size: u64,
}

fn hex(digest: &[u8]) -> String {
  digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 流式计算文件的 SHA-256 (与 Tauri 无关, 便于单测)
pub fn sha256_file(path: &Path) -> Result<String, String> {
  let mut file = std::fs::File::open(path).map_err(|e| {
    if e.kind() == std::io::ErrorKind::NotFound {
      format!("not_found: {e}")
    } else {
      format!("file: {e}")
    }
  })?;
  let mut hasher = Sha256::new();
  let mut buf = vec![0u8; 1024 * 1024];
  loop {
    let n = file.read(&mut buf).map_err(|e| format!("file: {e}"))?;
    if n == 0 {
      break;
    }
    hasher.update(&buf[..n]);
  }
  Ok(hex(&hasher.finalize()))
}

/// GET `spec.url` 写到 `dest`. 非 2xx 不建文件, 返回状态码; 中途出错删除半截文件 (与 Tauri 无关, 便于单测)
pub async fn download_to(spec: &UploadSpec, dest: &Path, stall: Duration) -> Result<DownloadResult, String> {
  let client = build_client(spec, DOWNLOAD_TIMEOUT)?;
  let mut req = client.get(&spec.url);
  for (name, value) in &spec.headers {
    req = req.header(name.as_str(), value.as_str());
  }
  let mut res = req.send().await.map_err(map_err)?;
  let status = res.status().as_u16();
  if !res.status().is_success() {
    return Ok(DownloadResult { status, sha256: String::new(), size: 0 });
  }
  let result = async {
    let mut file = std::fs::File::create(dest).map_err(|e| format!("file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    loop {
      let chunk = tokio::time::timeout(stall, res.chunk())
        .await
        .map_err(|_| "timeout: 下载卡住".to_string())?
        .map_err(map_err)?;
      let Some(chunk) = chunk else { break };
      file.write_all(&chunk).map_err(|e| format!("file: {e}"))?;
      hasher.update(&chunk);
      size += chunk.len() as u64;
    }
    file.flush().map_err(|e| format!("file: {e}"))?;
    Ok::<_, String>(DownloadResult { status, sha256: hex(&hasher.finalize()), size })
  }
  .await;
  if result.is_err() {
    let _ = std::fs::remove_file(dest);
  }
  result
}

/// 在 `offset` 处写入一块: 0 表示新建 (清空旧内容), 否则必须正好接在已写内容之后,
/// 防止重试或乱序把文件拼错 (与 Tauri 无关, 便于单测). 返回写完后的文件长度.
pub fn write_chunk(path: &Path, offset: u64, bytes: &[u8]) -> Result<u64, String> {
  let mut file = if offset == 0 {
    std::fs::File::create(path)
  } else {
    std::fs::OpenOptions::new().write(true).open(path)
  }
  .map_err(|e| format!("file: {e}"))?;
  let len = file.seek(SeekFrom::End(0)).map_err(|e| format!("file: {e}"))?;
  if len != offset {
    return Err(format!("file: 写入位置不连续 (已有 {len} 字节, 请求写在 {offset})"));
  }
  file.write_all(bytes).map_err(|e| format!("file: {e}"))?;
  Ok(offset + bytes.len() as u64)
}

fn library_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: String, rel: String) -> Result<std::path::PathBuf, String> {
  resolve_library_file(app.path().app_data_dir().ok(), &FileRef { root, rel })
}

#[tauri::command]
pub async fn library_file_sha256(app: tauri::AppHandle, root: String, rel: String) -> Result<String, String> {
  let path = library_path(&app, root, rel)?;
  tauri::async_runtime::spawn_blocking(move || sha256_file(&path))
    .await
    .map_err(|e| format!("file: {e}"))?
}

#[tauri::command]
pub async fn library_file_download(
  app: tauri::AppHandle,
  url: String,
  headers: BTreeMap<String, String>,
  proxy: Option<String>,
  root: String,
  rel: String,
) -> Result<DownloadResult, String> {
  let dest = library_path(&app, root, rel)?;
  let spec = UploadSpec {
    url,
    method: "GET".into(),
    headers: headers.into_iter().collect(),
    proxy,
    no_redirect: false,
  };
  download_to(&spec, &dest, STALL_TIMEOUT).await
}

#[tauri::command]
pub fn library_file_rename<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, from: String, to: String) -> Result<(), String> {
  let from = library_path(&app, root.clone(), from)?;
  let to = library_path(&app, root, to)?;
  if let Some(parent) = to.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("file: {e}"))?;
  }
  std::fs::rename(&from, &to).map_err(|e| format!("file: {e}"))
}

/// 删除由书文件派生的缓存 (`<文件名>.<后缀>`, 如 CBR 的 `.cbz`、TXT 的 `.v3.epub`), 删书时调用
#[tauri::command]
pub fn library_file_remove_derived<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, rel: String) -> Result<u32, String> {
  let path = library_path(&app, root, rel)?;
  let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else { return Ok(0) };
  let prefix = format!("{name}.");
  let mut removed = 0;
  for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
    if entry.file_name().to_string_lossy().starts_with(&prefix) && entry.file_type().is_ok_and(|t| t.is_file()) {
      if std::fs::remove_file(entry.path()).is_ok() {
        removed += 1;
      }
    }
  }
  Ok(removed)
}

/// 书库文件的字节数 (只读元数据, 不读内容)
#[tauri::command]
pub fn library_file_size<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, rel: String) -> Result<u64, String> {
  let path = library_path(&app, root, rel)?;
  std::fs::metadata(&path).map(|m| m.len()).map_err(|e| format!("file: {e}"))
}

#[tauri::command]
pub fn library_file_remove(app: tauri::AppHandle, root: String, rel: String) -> Result<(), String> {
  let path = library_path(&app, root, rel)?;
  match std::fs::remove_file(&path) {
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("file: {e}")),
    _ => Ok(()),
  }
}

/// 将书库内的源文件直接复制到用户指定的目标路径 (零 JS 内存拷贝, 支持任意盘符)
#[tauri::command]
pub async fn library_file_export<R: tauri::Runtime>(
  app: tauri::AppHandle<R>,
  root: String,
  rel: String,
  dest: String,
) -> Result<(), String> {
  let src = library_path(&app, root, rel)?;
  let dest_path = std::path::PathBuf::from(&dest);
  if dest_path.as_os_str().is_empty() {
    return Err("file: 目标路径不能为空".into());
  }
  tauri::async_runtime::spawn_blocking(move || {
    if src == dest_path
      || matches!(
        (std::fs::canonicalize(&src), std::fs::canonicalize(&dest_path)),
        (Ok(a), Ok(b)) if a == b
      )
    {
      return Ok(());
    }
    if let Some(parent) = dest_path.parent() {
      if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(parent).map_err(|e| format!("file: {e}"))?;
      }
    }
    std::fs::copy(&src, &dest_path).map_err(|e| format!("file: {e}"))?;
    Ok(())
  })
  .await
  .map_err(|e| format!("file: {e}"))?
}

fn export_file_to_dir_unique(src: &Path, dir_path: &Path, clean_name: &str) -> Result<String, String> {
  std::fs::create_dir_all(dir_path).map_err(|e| format!("file: {e}"))?;
  let (stem, ext): (&str, Option<&str>) =
    if clean_name.to_ascii_lowercase().ends_with(".fb2.zip") && clean_name.len() > 8 {
      (&clean_name[..clean_name.len() - 8], Some("fb2.zip"))
    } else {
      (
        Path::new(clean_name)
          .file_stem()
          .and_then(|s| s.to_str())
          .unwrap_or("book"),
        Path::new(clean_name)
          .extension()
          .and_then(|e| e.to_str()),
      )
    };

  let mut idx = 1u32;
  loop {
    let next_name = if idx == 1 {
      clean_name.to_string()
    } else {
      match ext {
        Some(e) if !e.is_empty() => format!("{stem} ({idx}).{e}"),
        _ => format!("{stem} ({idx})"),
      }
    };
    let candidate = dir_path.join(next_name);
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
      Ok(mut dst) => {
        let mut src_file = match std::fs::File::open(src) {
          Ok(f) => f,
          Err(e) => {
            drop(dst);
            let _ = std::fs::remove_file(&candidate);
            return Err(format!("file: {e}"));
          }
        };
        if let Err(e) = std::io::copy(&mut src_file, &mut dst) {
          drop(dst);
          let _ = std::fs::remove_file(&candidate);
          return Err(format!("file: {e}"));
        }
        return Ok(candidate.to_string_lossy().into_owned());
      }
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
        idx += 1;
      }
      // Windows 对已有同名目录执行 create_new(true) 会返回 PermissionDenied
      Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && candidate.is_dir() => {
        idx += 1;
      }
      Err(e) => return Err(format!("file: {e}")),
    }
  }
}

/// 批量导出到指定目录: 若目标文件名已存在, 自动追加 ` (2)`、` (3)` 避免覆盖, 返回实际写入路径
#[tauri::command]
pub async fn library_file_export_to_dir<R: tauri::Runtime>(
  app: tauri::AppHandle<R>,
  root: String,
  rel: String,
  dir: String,
  file_name: String,
) -> Result<String, String> {
  let src = library_path(&app, root, rel)?;
  let dir_path = std::path::PathBuf::from(&dir);
  if dir_path.as_os_str().is_empty() {
    return Err("file: 目标文件夹不能为空".into());
  }
  let clean_name = Path::new(&file_name)
    .file_name()
    .and_then(|n| n.to_str())
    .ok_or_else(|| "file: 文件名无效".to_string())?
    .to_string();

  tauri::async_runtime::spawn_blocking(move || export_file_to_dir_unique(&src, &dir_path, &clean_name))
  .await
  .map_err(|e| format!("file: {e}"))?
}

#[tauri::command]
pub async fn library_file_write_chunk(
  app: tauri::AppHandle,
  root: String,
  rel: String,
  offset: u64,
  data: String,
) -> Result<u64, String> {
  use base64::Engine as _;
  let path = library_path(&app, root, rel)?;
  tauri::async_runtime::spawn_blocking(move || {
    let bytes = base64::engine::general_purpose::STANDARD
      .decode(data.as_bytes())
      .map_err(|e| format!("request: base64 无效: {e}"))?;
    write_chunk(&path, offset, &bytes)
  })
  .await
  .map_err(|e| format!("file: {e}"))?
}

/// 换书库文件夹的复制进度: `stage` 为 `db` / `books` / `covers`, `done`/`total` 为该阶段的文件数
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct MigrateProgress {
  pub stage: &'static str,
  pub done: usize,
  pub total: usize,
}

const DB_FILES: [&str; 3] = ["lightread.db", "lightread.db-wal", "lightread.db-shm"];
const LIBRARY_DIRS: [&str; 2] = ["books", "covers"];

/// 把书库复制到 `dest`: `db_dir` 里的 SQLite 主库 (含 WAL), `data_dir` 下 books/ covers/ 的文件 (不递归).
/// 返回复制的字节数. 与 Tauri 无关, 便于单测.
pub fn copy_library(
  data_dir: &Path,
  db_dir: &Path,
  dest: &Path,
  mut progress: impl FnMut(MigrateProgress),
) -> Result<u64, String> {
  let io = |e: std::io::Error| format!("file: {e}");
  for dir in LIBRARY_DIRS {
    std::fs::create_dir_all(dest.join(dir)).map_err(io)?;
  }
  let mut bytes = 0u64;
  let dbs: Vec<_> = DB_FILES.iter().filter(|name| db_dir.join(name).is_file()).collect();
  for (i, name) in dbs.iter().enumerate() {
    progress(MigrateProgress { stage: "db", done: i, total: dbs.len() });
    bytes += std::fs::copy(db_dir.join(name), dest.join(name)).map_err(io)?;
  }
  for dir in LIBRARY_DIRS {
    let src = data_dir.join(dir);
    let files: Vec<_> = match std::fs::read_dir(&src) {
      Ok(entries) => entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .collect(),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
      Err(e) => return Err(io(e)),
    };
    for (i, entry) in files.iter().enumerate() {
      progress(MigrateProgress { stage: dir, done: i + 1, total: files.len() });
      bytes += std::fs::copy(entry.path(), dest.join(dir).join(entry.file_name())).map_err(io)?;
    }
  }
  Ok(bytes)
}

/// 换书库文件夹: 从当前书库 (`from_root` 为空表示默认的应用数据目录) 整库复制到 `to_root`.
/// 完成后由前端写入 libraryRoot 设置并整页重载.
#[tauri::command]
pub async fn library_migrate<R: tauri::Runtime>(
  app: tauri::AppHandle<R>,
  from_root: String,
  to_root: String,
  on_progress: Channel<MigrateProgress>,
) -> Result<u64, String> {
  let dest = std::path::PathBuf::from(to_root.trim_end_matches(['/', '\\']));
  if !dest.is_absolute() {
    return Err(format!("file: 目标文件夹必须是绝对路径 {to_root}"));
  }
  let from = from_root.trim_end_matches(['/', '\\']);
  let (data_dir, db_dir) = if from.is_empty() {
    let paths = app.path();
    (
      paths.app_data_dir().map_err(|e| format!("file: {e}"))?,
      // SQLite 主库在 AppConfig (macOS 上与 AppData 同目录, 其他平台不同)
      paths.app_config_dir().map_err(|e| format!("file: {e}"))?,
    )
  } else {
    let p = std::path::PathBuf::from(from);
    if !p.is_absolute() || !p.join("lightread.db").is_file() {
      return Err(format!("file: 不是轻阅书库目录 {from}"));
    }
    (p.clone(), p)
  };
  if dest == data_dir {
    return Err("file: 新文件夹就是当前书库".into());
  }
  tauri::async_runtime::spawn_blocking(move || {
    copy_library(&data_dir, &db_dir, &dest, |p| {
      let _ = on_progress.send(p);
    })
  })
  .await
  .map_err(|e| format!("file: {e}"))?
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::net::TcpListener;

  /// 收一个请求, 回 `status` + `body`; `stall_after` 字节后停住不发
  fn serve_once(status: &'static str, body: Vec<u8>, stall_after: Option<usize>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut buf = [0u8; 4096];
      let _ = stream.read(&mut buf);
      let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
      stream.write_all(head.as_bytes()).unwrap();
      let end = stall_after.unwrap_or(body.len());
      stream.write_all(&body[..end]).unwrap();
      stream.flush().unwrap();
      if stall_after.is_some() {
        std::thread::sleep(Duration::from_secs(3));
      }
    });
    format!("http://{addr}/f")
  }

  fn spec(url: String) -> UploadSpec {
    UploadSpec { url, method: "GET".into(), headers: vec![], proxy: None, no_redirect: false }
  }

  fn temp(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("lr-libfile-{}-{name}", std::process::id()))
  }

  #[test]
  fn copies_library_db_books_and_covers() {
    let base = temp("migrate");
    let (data, db, dest) = (base.join("data"), base.join("config"), base.join("dest"));
    for dir in [data.join("books"), data.join("covers"), db.clone()] {
      std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(db.join("lightread.db"), b"db").unwrap();
    std::fs::write(db.join("lightread.db-wal"), b"wal").unwrap();
    std::fs::write(data.join("books/a.epub"), vec![7u8; 5000]).unwrap();
    std::fs::write(data.join("books/b.pdf"), b"pdf").unwrap();
    std::fs::write(data.join("covers/a.jpg"), b"jpg").unwrap();
    std::fs::create_dir_all(data.join("books/nested")).unwrap();

    let mut seen = vec![];
    let bytes = copy_library(&data, &db, &dest, |p| seen.push(p)).unwrap();
    assert_eq!(bytes, 2 + 3 + 5000 + 3 + 3);
    assert_eq!(std::fs::read(dest.join("lightread.db-wal")).unwrap(), b"wal");
    assert!(!dest.join("lightread.db-shm").exists());
    assert_eq!(std::fs::read(dest.join("books/a.epub")).unwrap(), vec![7u8; 5000]);
    assert_eq!(std::fs::read(dest.join("covers/a.jpg")).unwrap(), b"jpg");
    assert!(!dest.join("books/nested").exists(), "子目录不复制");
    assert_eq!(seen.iter().filter(|p| p.stage == "books").last(), Some(&MigrateProgress { stage: "books", done: 2, total: 2 }));
    assert_eq!(seen.iter().filter(|p| p.stage == "db").count(), 2);
    std::fs::remove_dir_all(&base).unwrap();
  }

  #[test]
  fn copy_library_tolerates_missing_cover_dir() {
    let base = temp("migrate-empty");
    let (data, dest) = (base.join("data"), base.join("dest"));
    std::fs::create_dir_all(data.join("books")).unwrap();
    std::fs::write(data.join("lightread.db"), b"db").unwrap();
    assert_eq!(copy_library(&data, &data, &dest, |_| {}).unwrap(), 2);
    assert!(dest.join("covers").is_dir());
    std::fs::remove_dir_all(&base).unwrap();
  }

  #[test]
  fn hashes_files_in_chunks() {
    let path = temp("hash");
    // 跨过 1 MB 缓冲区边界
    let data: Vec<u8> = (0..(3 * 1024 * 1024 + 17)).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &data).unwrap();
    assert_eq!(sha256_file(&path).unwrap(), hex(&Sha256::digest(&data)));
    std::fs::remove_file(&path).unwrap();
    assert!(sha256_file(&path).unwrap_err().starts_with("not_found:"));
    let missing_dir_file = path.with_file_name("missing-subdir").join("book.cbz");
    assert!(sha256_file(&missing_dir_file).unwrap_err().starts_with("not_found:"));
  }

  #[tokio::test]
  async fn downloads_to_file_and_hashes() {
    let body: Vec<u8> = (0..200_000).map(|i| (i % 7) as u8).collect();
    let dest = temp("dl");
    let res = download_to(&spec(serve_once("200 OK", body.clone(), None)), &dest, STALL_TIMEOUT).await.unwrap();
    assert_eq!(res, DownloadResult { status: 200, sha256: hex(&Sha256::digest(&body)), size: body.len() as u64 });
    assert_eq!(std::fs::read(&dest).unwrap(), body);
    std::fs::remove_file(&dest).unwrap();
  }

  #[tokio::test]
  async fn missing_file_reports_status_without_creating() {
    let dest = temp("404");
    let res = download_to(&spec(serve_once("404 Not Found", b"no".to_vec(), None)), &dest, STALL_TIMEOUT).await.unwrap();
    assert_eq!(res.status, 404);
    assert!(res.sha256.is_empty());
    assert!(!dest.exists());
  }

  #[tokio::test]
  async fn stalled_download_removes_partial_file() {
    let dest = temp("stall");
    let url = serve_once("200 OK", vec![1u8; 10_000], Some(100));
    let err = download_to(&spec(url), &dest, Duration::from_millis(300)).await.unwrap_err();
    assert!(err.starts_with("timeout:"), "{err}");
    assert!(!dest.exists());
  }

  #[test]
  fn writes_chunks_in_order_and_rejects_gaps() {
    let path = temp("chunks");
    std::fs::write(&path, b"stale content").unwrap();
    assert_eq!(write_chunk(&path, 0, b"abc").unwrap(), 3);
    assert_eq!(write_chunk(&path, 3, b"defg").unwrap(), 7);
    // 重试已写过的块 / 跳过一块都拒绝, 文件保持原样
    assert!(write_chunk(&path, 3, b"defg").unwrap_err().starts_with("file:"));
    assert!(write_chunk(&path, 9, b"x").unwrap_err().starts_with("file:"));
    assert_eq!(std::fs::read(&path).unwrap(), b"abcdefg");
    // 非 0 偏移不会凭空建文件
    let missing = temp("chunks-missing");
    let _ = std::fs::remove_file(&missing);
    assert!(write_chunk(&missing, 5, b"x").is_err());
    assert!(!missing.exists());
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn export_file_to_dir_preserves_fb2_zip_and_cleans_up_missing_src() {
    let base = temp("export-fb2");
    let src_dir = base.join("src");
    let dst_dir = base.join("dst");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::create_dir_all(&dst_dir).unwrap();

    let src = src_dir.join("book.fb2.zip");
    std::fs::write(&src, b"fb2-payload").unwrap();
    std::fs::write(dst_dir.join("novel.fb2.zip"), b"existing").unwrap();

    let exported = export_file_to_dir_unique(&src, &dst_dir, "novel.fb2.zip").unwrap();
    assert_eq!(Path::new(&exported).file_name().unwrap().to_str().unwrap(), "novel (2).fb2.zip");
    assert_eq!(std::fs::read(&exported).unwrap(), b"fb2-payload");
    assert_eq!(std::fs::read(dst_dir.join("novel.fb2.zip")).unwrap(), b"existing");

    let missing = src_dir.join("missing.cbz");
    assert!(export_file_to_dir_unique(&missing, &dst_dir, "broken.cbz").is_err());
    assert!(!dst_dir.join("broken.cbz").exists());

    std::fs::remove_dir_all(&base).unwrap();
  }

  #[test]
  fn export_file_to_dir_concurrent_same_title_keeps_both_and_existing() {
    let base = temp("export-concurrent");
    let src_dir = base.join("src");
    let dst_dir = base.join("dst");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::create_dir_all(&dst_dir).unwrap();

    let src1 = src_dir.join("1.cbz");
    let src2 = src_dir.join("2.cbz");
    std::fs::write(&src1, b"first-book-bytes").unwrap();
    std::fs::write(&src2, b"second-book-bytes").unwrap();
    std::fs::write(dst_dir.join("same.cbz"), b"pre-existing").unwrap();

    let d1 = dst_dir.clone();
    let d2 = dst_dir.clone();
    let t1 = std::thread::spawn(move || export_file_to_dir_unique(&src1, &d1, "same.cbz"));
    let t2 = std::thread::spawn(move || export_file_to_dir_unique(&src2, &d2, "same.cbz"));

    let p1 = t1.join().unwrap().unwrap();
    let p2 = t2.join().unwrap().unwrap();
    assert_ne!(p1, p2);

    let mut contents = vec![std::fs::read(&p1).unwrap(), std::fs::read(&p2).unwrap()];
    contents.sort();
    assert_eq!(contents, vec![b"first-book-bytes".to_vec(), b"second-book-bytes".to_vec()]);
    assert_eq!(std::fs::read(dst_dir.join("same.cbz")).unwrap(), b"pre-existing");

    std::fs::remove_dir_all(&base).unwrap();
  }

  #[test]
  fn export_file_to_dir_skips_existing_directory_and_errors_on_invalid_dest() {
    let base = temp("export-dir-collision");
    let src_dir = base.join("src");
    let dst_dir = base.join("dst");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::create_dir_all(dst_dir.join("same.cbz")).unwrap();

    let src = src_dir.join("book.cbz");
    std::fs::write(&src, b"dir-collision-payload").unwrap();

    let exported = export_file_to_dir_unique(&src, &dst_dir, "same.cbz").unwrap();
    assert_eq!(Path::new(&exported).file_name().unwrap().to_str().unwrap(), "same (2).cbz");
    assert!(dst_dir.join("same.cbz").is_dir());
    assert_eq!(std::fs::read(&exported).unwrap(), b"dir-collision-payload");

    // 目标路径本身是普通文件而非目录时，create_dir_all / open 应立即返回错误
    let file_as_dir = base.join("not-a-dir");
    std::fs::write(&file_as_dir, b"file").unwrap();
    assert!(export_file_to_dir_unique(&src, &file_as_dir, "out.cbz").unwrap_err().starts_with("file:"));

    std::fs::remove_dir_all(&base).unwrap();
  }
}
