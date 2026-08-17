use std::io::{self, Read, Write};

static STDOUT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Read one native message from stdin (4-byte LE length prefix + JSON).
/// Returns None on EOF or error (browser disconnected).
pub fn read_native_message() -> Option<serde_json::Value> {
    let mut len_buf = [0u8; 4];
    io::stdin().read_exact(&mut len_buf).ok()?;
    let len = u32::from_ne_bytes(len_buf) as usize;
    if len == 0 || len > 10 * 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; len];
    io::stdin().read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

/// Write one native message to stdout (4-byte LE length prefix + JSON).
pub fn write_native_message(msg: &serde_json::Value) {
    let Ok(_guard) = STDOUT_LOCK.lock() else {
        return;
    };
    let buf = serde_json::to_vec(msg).unwrap();
    let len_buf = (buf.len() as u32).to_ne_bytes();
    let mut stdout = io::stdout();
    let _ = stdout.write_all(&len_buf);
    let _ = stdout.write_all(&buf);
    let _ = stdout.flush();
}
