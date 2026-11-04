//! Long page snapshots from `read_tab` / `read_active_tab` are saved to disk and
//! replaced by the file path, so a long page costs the
//! agent's context only when it actually reads the file. Short pages stay
//! inline so the common case remains a single call.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use serde_json::{Value, json};

use crate::app_data;

/// Content longer than this many characters is saved to a file.
const INLINE_LIMIT: usize = 20_000;
/// Saved files older than this are deleted on the next save.
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// At most this many saved files are kept, newest first.
const MAX_FILES: usize = 50;

/// Moves an over-long `content` field of a read result into a file and drops it
/// from the result. Leaves the
/// result untouched when the content is short or `inline` is set.
pub fn offload_content(resp: &mut Value, inline: bool) -> Result<()> {
    let Some(content) = resp.get("content").and_then(Value::as_str) else {
        return Ok(());
    };
    let length = content.chars().count();
    if inline || length <= INLINE_LIMIT {
        return Ok(());
    }

    let dir = app_data::page_dir()?;
    prune(&dir);
    let tab_id = resp.get("tabId").and_then(Value::as_i64).unwrap_or_default();
    let millis = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let path = dir.join(format!("tab-{tab_id}-{millis}.html"));
    fs::write(&path, content)?;

    let obj = resp.as_object_mut().expect("content exists, so resp is an object");
    obj.remove("content");
    obj.insert("contentLength".into(), json!(length));
    obj.insert("contentFile".into(), json!(path));
    obj.insert(
        "contentHint".into(),
        json!(format!(
            "Content is {length} characters, saved to contentFile instead of returned. If tools[] \
             has a matching page tool, use it instead. Otherwise search or read contentFile, or \
             call again with inline_content: true to get it inline."
        )),
    );
    Ok(())
}

/// Deletes saved files older than [`MAX_AGE`], then the oldest beyond
/// [`MAX_FILES`] - 1 so the file about to be written still fits the cap.
fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (i, (modified, path)) in files.iter().enumerate() {
        let expired = now.duration_since(*modified).unwrap_or_default() > MAX_AGE;
        if expired || i + 1 >= MAX_FILES {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_or_inline_content_stays_inline() {
        let short = json!({ "tabId": 1, "content": "<p>hi</p>" });
        let mut resp = short.clone();
        offload_content(&mut resp, false).unwrap();
        assert_eq!(resp, short);

        let long = json!({ "tabId": 1, "content": "x".repeat(INLINE_LIMIT + 1) });
        let mut resp = long.clone();
        offload_content(&mut resp, true).unwrap();
        assert_eq!(resp, long);
    }

    #[test]
    fn prune_keeps_room_for_the_next_file() {
        let dir = std::env::temp_dir().join(format!("b4a-page-store-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for i in 0..MAX_FILES + 2 {
            fs::write(dir.join(format!("{i}.html")), "").unwrap();
        }
        prune(&dir);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), MAX_FILES - 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
