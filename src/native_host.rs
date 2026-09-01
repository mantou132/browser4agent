use std::sync::{Arc, Mutex};

use anyhow::Result;
use rmcp::transport::streamable_http_server::{
    StreamableHttpService, session::local::LocalSessionManager,
};

use crate::{
    browser_agent,
    constant::{BIND_ADDRESS, MCP_PATH},
    logger,
    mcp_server::{BrowserMcpServer, Capabilities, SharedCapabilities},
    native_messaging::read_native_message,
    peer::Peer,
    relay_client,
};

/// Run the native messaging loop on the current thread.
/// Returns when stdin is closed (browser disconnected).
async fn native_message_loop(peer: Peer) {
    peer.notify(
        "connected",
        serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }),
    );
    logger::info("Connected to browser extension");

    loop {
        if let Some(msg) = read_native_message() {
            logger::log(&format!("Received from extension: {:?}", msg));
            peer.dispatch(msg).await;
        } else {
            logger::info("Stdin closed, browser disconnected");
            break;
        }
    }
}

pub async fn run() -> Result<()> {
    let peer = Peer::default();
    browser_agent::register(&peer);

    let caps: SharedCapabilities = Arc::default();
    let remote_peer: Arc<Mutex<Option<Peer>>> = Arc::default();
    {
        let caps = caps.clone();
        let remote_peer = remote_peer.clone();
        // The extension reports this right after receiving `connected`.
        peer.on_notify("capabilities", move |params| {
            *caps.lock().expect("lock poisoned") = Capabilities::from_params(&params);
            let Some(relay_id) = params
                .get("relayId")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                return;
            };

            // The remote peer owns a separate RPC id space and Agent session
            // manager. Start it only after the extension supplies its stable
            // pairing id, and retain it for this process's lifetime.
            let mut remote_peer = remote_peer.lock().expect("lock poisoned");
            if remote_peer.is_some() {
                return;
            }
            match relay_client::start(relay_id) {
                Ok(peer) => *remote_peer = Some(peer),
                Err(error) => logger::info(&format!("Remote relay disabled: {error:#}")),
            }
        });
    }

    let server = BrowserMcpServer::new(peer.clone(), caps);

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
            let listener = match tokio::net::TcpListener::bind(BIND_ADDRESS).await {
                Ok(l) => l,
                Err(e) => {
                    logger::info(&format!("Failed to bind {BIND_ADDRESS}: {e}, exiting"));
                    std::process::exit(1);
                }
            };
            logger::info(&format!(
                "MCP server listening on http://{}{}",
                BIND_ADDRESS, MCP_PATH
            ));
            if let Err(e) = axum::serve(listener, router).await {
                logger::info(&format!("MCP server error: {e}"));
            }
        });
    });

    // Main thread: native messaging loop. Exits when browser closes stdin.
    native_message_loop(peer).await;

    Ok(())
}
