mod ai_tool_setup;
mod constant;
mod logger;
mod mcp_server;
mod native_host;
mod native_message_setup;
use std::{
    env,
    io::{self, Read},
};

use anyhow::Result;

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
            "browser4agent",
            "Browser for AI Agent",
            &[
                "kaanjpgabaklepokebpdojepkccmbpng",
                "cddjomjjojijahpjngcfebapepdecaff",
                "kgofhkkibnooojbchfppjblmajdcboib",
            ],
            &["browser4agent@xianqiao.wang"],
        )?;

        ai_tool_setup::setup_ai_tools()?;

        println!("\nPress any key to exit...");
        let _ = io::stdin().read_exact(&mut [0u8; 1]);
    }

    Ok(())
}
