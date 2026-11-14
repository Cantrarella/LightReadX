use std::{
  fs,
  io::{self, ErrorKind},
  path::Path,
};

const COMPLETE: &str = ".lightreadx-legacy-migration-v1";
const PARTIAL: &str = ".lightreadx-migration-part";

/// Reuse existing destination files and publish each new file after the copy
/// succeeds. A restart can safely resume until the completion marker exists.
pub(crate) fn migrate_directory(source: &Path, target: &Path, anchors: &[&str]) -> io::Result<()> {
  if target.join(COMPLETE).try_exists()? {
    return Ok(());
  }
  let mut has_legacy_data = false;
  for anchor in anchors {
    has_legacy_data |= source.join(anchor).try_exists()?;
  }
  if !has_legacy_data {
    return Ok(());
  }

  fs::create_dir_all(target)?;
  let partial = target.join(PARTIAL);
  let has_database = target.join("lightread.db").try_exists()?;
  copy_missing(source, target, &partial, Some(has_database))?;
  if !has_database && source.join("lightread.db").try_exists()? {
    copy_file(&source.join("lightread.db"), &target.join("lightread.db"), &partial)?;
  }
  fs::File::create(target.join(COMPLETE))?.sync_all()
}

fn copy_missing(source: &Path, target: &Path, partial: &Path, has_database: Option<bool>) -> io::Result<()> {
  fs::create_dir_all(target)?;
  for entry in fs::read_dir(source)? {
    let entry = entry?;
    let name = entry.file_name();
    if name == COMPLETE || name == PARTIAL {
      continue;
    }
    // Copy a newly migrated database after its journal files. Do not attach
    // journals from the legacy database to an existing destination database.
    let database_file = has_database.is_some() && name == "lightread.db";
    let database_journal = has_database == Some(true)
      && matches!(name.to_str(), Some("lightread.db-wal" | "lightread.db-shm" | "lightread.db-journal"));
    if database_file || database_journal {
      continue;
    }
    let kind = entry.file_type()?;
    let destination = target.join(&name);
    if kind.is_dir() {
      copy_missing(&entry.path(), &destination, partial, None)?;
    } else if kind.is_file() {
      copy_file(&entry.path(), &destination, partial)?;
    }
  }
  Ok(())
}

fn copy_file(source: &Path, target: &Path, partial: &Path) -> io::Result<()> {
  match fs::metadata(target) {
    Ok(meta) if meta.is_file() => return Ok(()),
    Ok(_) => return Err(io::Error::new(ErrorKind::AlreadyExists, target.display().to_string())),
    Err(error) if error.kind() == ErrorKind::NotFound => {}
    Err(error) => return Err(error),
  }

  fs::copy(source, partial)?;
  fs::OpenOptions::new().write(true).open(partial)?.sync_all()?;
  fs::rename(partial, target)
}

#[cfg(test)]
#[path = "legacy_migration_tests.rs"]
mod tests;
