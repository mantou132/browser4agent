mod logger;
mod mcp_server;
mod native_host;
mod native_message_setup;
use anyhow::Result;
use std::env;
use std::io::{self, Read};

// chrome has extension id, firefox has manifest path & extension id
fn is_launched_by_browser() -> bool {
    let args: Vec<String> = env::args().collect();
    args.len() > 1 && (args[1].starts_with("chrome-extension://") || args.len() > 2)
}

#[tokio::main]
async fn main() -> Result<()> {
    if is_launched_by_browser() {
        native_host::run().await?;
    } else {
        native_message_setup::install_native_message_host(
            "browser_data_mcp",
            "Browser Data MCP - provides browser tab data to AI agent",
            Some("kaanjpgabaklepokebpdojepkccmbpng"),
            Some("browser-data-mcp@xianqiao.wang"),
        )?;
        println!("\nNative messaging host installed successfully!");
        println!("Press any key to exit...");
        let _ = io::stdin().read_exact(&mut [0u8; 1]);
    }

    Ok(())
}
