use anyhow::Result;
use rmcp::transport::streamable_http_server::{
    StreamableHttpService, session::local::LocalSessionManager,
};

use crate::{
    browser_agent::BrowserAgentBridge,
    constant::{BIND_ADDRESS, MCP_PATH},
    extension_rpc::ExtensionRpcClient,
    logger,
    mcp_server::BrowserMcpServer,
    native_messaging::{read_native_message, write_native_message},
};

/// Run the native messaging loop on the current thread.
/// Returns when stdin is closed (browser disconnected).
async fn native_message_loop(extension_rpc: ExtensionRpcClient, agent_bridge: BrowserAgentBridge) {
    write_native_message(&serde_json::json!({"type": "connected"}));
    logger::info("Connected to browser extension");

    loop {
        if let Some(msg) = read_native_message() {
            logger::log(&format!("Received from extension: {:?}", msg));

            if agent_bridge.handle_message(msg.clone()) {
                continue;
            }

            if let Some(req_id) = msg.get("request_id").and_then(|v| v.as_u64()) {
                if !extension_rpc.deliver_response(req_id, msg.clone()).await {
                    logger::log(&format!("No pending request for response: {:?}", msg));
                }
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
    let extension_rpc = ExtensionRpcClient::new();
    let agent_bridge = BrowserAgentBridge::new();
    let server = BrowserMcpServer::new(extension_rpc.clone());

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
    native_message_loop(extension_rpc, agent_bridge).await;

    Ok(())
}
