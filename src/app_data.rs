use std::{fs, path::PathBuf};

use anyhow::{Context, Result};

const APP_DIRECTORY: &str = "browser4agent";

/// Per-user, machine-local storage for managed runtimes and logs.
pub fn root_dir() -> Result<PathBuf> {
    let dir = dirs::data_local_dir()
        .context("failed to resolve the local application data directory")?
        .join(APP_DIRECTORY);
    fs::create_dir_all(&dir).with_context(|| {
        format!(
            "failed to create application data directory: {}",
            dir.display()
        )
    })?;
    Ok(dir)
}

pub fn agent_runtime_dir(agent: &str) -> Result<PathBuf> {
    let dir = root_dir()?.join("agents").join(agent);
    fs::create_dir_all(&dir).with_context(|| {
        format!(
            "failed to create agent runtime directory: {}",
            dir.display()
        )
    })?;
    Ok(dir)
}

pub fn log_dir() -> Result<PathBuf> {
    let dir = root_dir()?.join("logs");
    fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create log directory: {}", dir.display()))?;
    Ok(dir)
}

pub fn npm_cache_dir() -> Result<PathBuf> {
    let dir = root_dir()?.join("npm-cache");
    fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create npm cache directory: {}", dir.display()))?;
    Ok(dir)
}
