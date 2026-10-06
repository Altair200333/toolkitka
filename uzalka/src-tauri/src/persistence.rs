use crate::Snapshot;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn snapshot_file() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|dir| dir.join("uzalka").join("usage.json"))
        .ok_or_else(|| "configuration directory unavailable".to_string())
}

pub fn load() -> Result<Option<Snapshot>, String> {
    read(&snapshot_file()?)
}

fn read(path: &Path) -> Result<Option<Snapshot>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let snapshot: Snapshot = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if snapshot.schema_version != 1 {
        return Err(format!("unsupported schema version {}", snapshot.schema_version));
    }
    Ok(Some(snapshot))
}

pub fn save(snapshot: &Snapshot) -> Result<(), String> {
    write(&snapshot_file()?, snapshot)
}

fn write(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(snapshot).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let result = (|| -> io::Result<()> {
        let mut file = File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // Same-directory rename replaces the existing file on Windows, too.
        // Never remove the destination first: a failure must preserve it.
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct TestFile(PathBuf);

    impl TestFile {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "uzalka-snapshot-{}-{}-{}.json", std::process::id(), crate::now_ms(), NEXT.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }

    impl Drop for TestFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    fn replaces_snapshot_and_preserves_timestamps_on_read() {
        let path = TestFile::new();
        assert!(read(&path.0).unwrap().is_none());
        let mut snapshot = Snapshot { generated_ms: 123, ..Snapshot::default() };
        write(&path.0, &snapshot).unwrap();
        assert_eq!(read(&path.0).unwrap().unwrap().generated_ms, 123);
        snapshot.generated_ms = 456;
        snapshot.paused = Some("test paused".into());
        write(&path.0, &snapshot).unwrap();
        let loaded = read(&path.0).unwrap().unwrap();
        assert_eq!(loaded.generated_ms, 456);
        assert_eq!(loaded.paused.as_deref(), Some("test paused"));
    }

    #[test]
    fn rejects_corrupt_and_unknown_schema() {
        let path = TestFile::new();
        fs::write(&path.0, b"{").unwrap();
        assert!(read(&path.0).is_err());
        write(&path.0, &Snapshot { schema_version: 2, ..Snapshot::default() }).unwrap();
        assert!(read(&path.0).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn failed_replacement_preserves_previous_snapshot() {
        use std::os::windows::fs::OpenOptionsExt;
        let path = TestFile::new();
        write(&path.0, &Snapshot { generated_ms: 123, ..Snapshot::default() }).unwrap();
        let locked = fs::OpenOptions::new().read(true).share_mode(0).open(&path.0).unwrap();
        assert!(write(&path.0, &Snapshot { generated_ms: 456, ..Snapshot::default() }).is_err());
        drop(locked);
        assert_eq!(read(&path.0).unwrap().unwrap().generated_ms, 123);
    }
}
