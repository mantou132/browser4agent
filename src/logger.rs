use chrono::Local;
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

fn log_path() -> PathBuf {
    let mut path = env::current_exe().unwrap();
    let stem = path.file_stem().unwrap().to_os_string();
    path.set_file_name(stem);
    path.set_extension("log");
    path
}

fn write(level: &str, msg: &str) {
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(log_path())
        .expect("Couldn't open log file");
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
