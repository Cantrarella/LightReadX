use super::*;
use std::path::PathBuf;

struct Fixture(PathBuf);

impl Fixture {
  fn new(name: &str) -> Self {
    let path = std::env::temp_dir().join(format!("lightread-migration-{}-{name}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    Self(path)
  }
}

impl Drop for Fixture {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

#[test]
fn resumes_incomplete_migration_and_preserves_existing_files() {
  let root = Fixture::new("resume");
  let old = root.0.join("old");
  let new = root.0.join("new");
  fs::create_dir_all(old.join("books")).unwrap();
  fs::write(old.join("books/a.cbz"), b"old copy").unwrap();
  fs::write(old.join("books/b.cbz"), b"missing book").unwrap();
  fs::write(old.join("lightread.db"), b"legacy database").unwrap();
  fs::create_dir_all(new.join("books")).unwrap();
  fs::write(new.join("books/a.cbz"), b"existing copy").unwrap();

  migrate_directory(&old, &new, &["lightread.db", "books"]).unwrap();

  assert_eq!(fs::read(new.join("books/a.cbz")).unwrap(), b"existing copy");
  assert_eq!(fs::read(new.join("books/b.cbz")).unwrap(), b"missing book");
  assert_eq!(fs::read(new.join("lightread.db")).unwrap(), b"legacy database");

  fs::remove_file(new.join("books/b.cbz")).unwrap();
  migrate_directory(&old, &new, &["lightread.db", "books"]).unwrap();
  assert!(!new.join("books/b.cbz").exists(), "completed migrations must not restore deleted books");
}

#[test]
fn retries_after_error_without_overwriting_existing_files() {
  let root = Fixture::new("retry");
  let old = root.0.join("old");
  let new = root.0.join("new");
  fs::create_dir_all(old.join("books")).unwrap();
  fs::write(old.join("books/chapter.cbz"), b"chapter").unwrap();
  fs::create_dir_all(&new).unwrap();
  fs::write(new.join("books"), b"blocked directory").unwrap();

  assert!(migrate_directory(&old, &new, &["books"]).is_err());
  assert_eq!(fs::read(new.join("books")).unwrap(), b"blocked directory");
  fs::remove_file(new.join("books")).unwrap();

  migrate_directory(&old, &new, &["books"]).unwrap();
  assert_eq!(fs::read(new.join("books/chapter.cbz")).unwrap(), b"chapter");
}

#[test]
fn copies_legacy_webview_profile_into_a_fresh_destination_once() {
  let root = Fixture::new("webview");
  let old = root.0.join("old");
  let new = root.0.join("new");
  fs::create_dir_all(old.join("EBWebView/Default/Network")).unwrap();
  fs::write(old.join("EBWebView/Default/Network/Cookies"), b"legacy cookies").unwrap();

  migrate_directory(&old, &new, &[".cookies", "EBWebView"]).unwrap();
  let cookies = new.join("EBWebView/Default/Network/Cookies");
  assert_eq!(fs::read(&cookies).unwrap(), b"legacy cookies");
  fs::write(&cookies, b"current cookies").unwrap();
  migrate_directory(&old, &new, &[".cookies", "EBWebView"]).unwrap();
  assert_eq!(fs::read(cookies).unwrap(), b"current cookies");
}
