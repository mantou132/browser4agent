use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::Result;
use serde_json::json;

use crate::constant::{BIND_ADDRESS, MCP_PATH, SERVER_NAME};

fn get_url() -> String {
    format!("http://{}{}", BIND_ADDRESS, MCP_PATH)
}

fn check_config_for_url(config_path: &Path) -> Result<bool> {
    if !config_path.exists() {
        return Ok(false);
    }
    let content = fs::read_to_string(config_path)?;
    Ok(content.contains(&get_url()))
}

fn is_claude_code_installed() -> bool {
    Command::new("claude")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn is_claude_code_configured() -> Result<bool> {
    let output = Command::new("claude").args(["mcp", "list"]).output()?;
    if !output.status.success() {
        return Ok(false);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.contains(&get_url()))
}

fn add_claude_code_config() -> Result<bool> {
    if is_claude_code_configured()? {
        return Ok(true);
    }

    let status = Command::new("claude")
        .args([
            "mcp",
            "add",
            "--transport",
            "http",
            "--scope",
            "user",
            SERVER_NAME,
            &get_url(),
        ])
        .status()?;
    Ok(status.success())
}

fn is_vscode_installed() -> bool {
    Command::new("code")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn get_vscode_config_path() -> PathBuf {
    dirs::config_dir()
        .map(|p| p.join("Code/User/mcp.json"))
        .unwrap_or_else(|| PathBuf::from("mcp.json"))
}

fn add_vscode_config() -> Result<bool> {
    let config_path = &get_vscode_config_path();
    if check_config_for_url(config_path)? {
        return Ok(true);
    }

    let json_arg = format!(
        r#"{{"name":"{}","type":"http","url":"{}"}}"#,
        SERVER_NAME,
        get_url()
    );
    let status = Command::new("code")
        .arg("--add-mcp")
        .arg(json_arg)
        .status()?;
    Ok(status.success())
}

fn get_cursor_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".cursor/mcp.json")
}

fn is_cursor_installed() -> bool {
    get_cursor_config_path()
        .parent()
        .is_some_and(|p| p.exists())
}

fn add_cursor_config() -> Result<bool> {
    let config_path = &get_cursor_config_path();
    if check_config_for_url(config_path)? {
        return Ok(true);
    }

    let content = fs::read_to_string(config_path).unwrap_or_else(|_| "{}".to_string());
    let mut json = jsonc_parser::parse_to_serde_value(&content, &Default::default())
        .ok()
        .flatten()
        .unwrap_or(json!({}));
    if json.get("mcpServers").is_none() {
        json["mcpServers"] = json!({});
    }
    json["mcpServers"][SERVER_NAME] = json!({
        "url": get_url()
    });
    let json_str = serde_json::to_string_pretty(&json)?;
    fs::write(config_path, json_str)?;
    Ok(true)
}

fn get_zed_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/zed/settings.json")
}

fn is_zed_installed() -> bool {
    get_zed_config_path().exists()
}

fn add_zed_config() -> Result<bool> {
    let config_path = &get_zed_config_path();
    if check_config_for_url(config_path)? {
        return Ok(true);
    }

    let content = fs::read_to_string(config_path)?;
    let mut json = jsonc_parser::parse_to_serde_value(&content, &Default::default())
        .ok()
        .flatten()
        .unwrap_or(json!({}));
    if json.get("context_servers").is_none() {
        json["context_servers"] = json!({});
    }
    json["context_servers"][SERVER_NAME] = json!({
        "settings": {},
        "url": get_url()
    });
    let json_str = serde_json::to_string_pretty(&json)?;
    fs::write(config_path, json_str)?;
    Ok(true)
}

pub fn setup_ai_tools() -> Result<()> {
    println!("\nChecking AI tools and configuring MCP server...\n");

    if is_claude_code_installed() {
        add_claude_code_config()?;
        println!("MCP configured for Claude Code");
    }

    if is_vscode_installed() {
        add_vscode_config()?;
        println!("MCP configured for VS Code");
    }

    if is_cursor_installed() {
        add_cursor_config()?;
        println!("MCP configured for Cursor");
    }

    if is_zed_installed() {
        add_zed_config()?;
        println!("MCP configured for Zed");
    }

    println!("\nMCP configured successfully!");
    Ok(())
}
