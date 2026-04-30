use crate::logger;
use crate::mcp_server::BrowserDataServer;
use anyhow::Result;
use rmcp::transport::streamable_http_server::{
    StreamableHttpService, session::local::LocalSessionManager,
};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::Arc;
use tokio::sync::{Mutex, oneshot};

const BIND_ADDRESS: &str = "127.0.0.1:39271";
const MCP_PATH: &str = "/mcp";

/// Read one native message from stdin (4-byte LE length prefix + JSON).
/// Returns None on EOF or error (browser disconnected).
fn read_native_message() -> Option<serde_json::Value> {
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
fn write_native_message(msg: &serde_json::Value) {
    let buf = serde_json::to_vec(msg).unwrap();
    let len_buf = (buf.len() as u32).to_ne_bytes();
    let mut stdout = io::stdout();
    let _ = stdout.write_all(&len_buf);
    let _ = stdout.write_all(&buf);
    let _ = stdout.flush();
}

/// Shared state for sending requests to the browser extension and awaiting responses.
#[derive(Clone)]
pub struct NativeMessenger {
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_id: Arc<Mutex<u64>>,
}

impl NativeMessenger {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(0)),
        }
    }

    /// Send a request to the extension and return a oneshot receiver for the response.
    pub async fn request(&self, msg: &serde_json::Value) -> oneshot::Receiver<serde_json::Value> {
        let mut id = self.next_id.lock().await;
        *id += 1;
        let req_id = *id;
        drop(id);

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(req_id, tx);

        let mut out = msg.clone();
        out["request_id"] = serde_json::json!(req_id);
        write_native_message(&out);
        logger::log(&format!("Sent request to extension: {:?}", out));

        rx
    }

    /// Deliver a response from the extension to the waiting oneshot.
    pub async fn deliver_response(&self, request_id: u64, mut response: serde_json::Value) {
        if let Some(tx) = self.pending.lock().await.remove(&request_id) {
            if let Some(map) = response.as_object_mut() {
                map.remove("request_id");
            }
            let _ = tx.send(response);
        }
    }
}

/// Run the native messaging loop on the current thread.
/// Returns when stdin is closed (browser disconnected).
async fn native_message_loop(messenger: NativeMessenger) {
    write_native_message(&serde_json::json!({"type": "connected"}));
    logger::info("Connected to browser extension");

    loop {
        if let Some(msg) = read_native_message() {
            logger::log(&format!("Received from extension: {:?}", msg));

            if let Some(req_id) = msg.get("request_id").and_then(|v| v.as_u64()) {
                messenger.deliver_response(req_id, msg.clone()).await;
            } else {
                logger::log(&format!("Message without request_id: {:?}", msg));
            }
        } else {
            logger::info("Stdin closed, browser disconnected");
            break;
        }
    }
}

pub async fn run() -> Result<()> {
    let messenger = NativeMessenger::new();
    let server = BrowserDataServer::new(messenger.clone());

    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        LocalSessionManager::default().into(),
        Default::default(),
    );
    let router = axum::Router::new().nest_service(MCP_PATH, service);

    // MCP server on a background thread.
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to build MCP runtime");
        rt.block_on(async {
            let listener = tokio::net::TcpListener::bind(BIND_ADDRESS)
                .await
                .expect("Failed to bind MCP port");
            logger::info(&format!(
                "MCP server listening on http://{}{}",
                BIND_ADDRESS, MCP_PATH
            ));
            axum::serve(listener, router)
                .await
                .expect("MCP server error");
        });
    });

    // Main thread: native messaging loop. Exits when browser closes stdin.
    native_message_loop(messenger).await;

    Ok(())
}
