use anyhow::Result;
use rmcp::transport::streamable_http_server::{
    StreamableHttpService, session::local::LocalSessionManager,
};

use crate::{
    browser_agent,
    constant::{BIND_ADDRESS, MCP_PATH},
    logger,
    mcp_server::BrowserMcpServer,
    native_messaging::read_native_message,
    peer::Peer,
};

/// Run the native messaging loop on the current thread.
/// Returns when stdin is closed (browser disconnected).
async fn native_message_loop(peer: Peer) {
    peer.notify("connected", serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }));
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
    let server = BrowserMcpServer::new(peer.clone());

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
