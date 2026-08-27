use std::{fs::OpenOptions, io::Write, path::PathBuf};

use chrono::Local;

use crate::app_data;

fn log_path() -> anyhow::Result<PathBuf> {
    Ok(app_data::log_dir()?.join("browser4agent.log"))
}

fn write(level: &str, msg: &str) {
    let Ok(path) = log_path() else {
        return;
    };
    let Ok(mut file) = OpenOptions::new().append(true).create(true).open(path) else {
        return;
    };
    let ts = Local::now().format("%Y-%m-%d %H:%M:%S");
    let _ = writeln!(file, "{ts} [{level}] {msg}");
}

/// Info level — always written (important events).
pub fn info(msg: &str) {
    write("INFO", msg);
}

/// Debug level — only written in debug builds, stripped in release.
#[cfg(debug_assertions)]
pub fn log(msg: &str) {
    write("DEBUG", msg);
}

#[cfg(not(debug_assertions))]
pub fn log(msg: &str) {
    let _ = msg;
}
