use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::Result;
use serde_json::{Value, json};

use crate::constant::{BIND_ADDRESS, MCP_PATH, SERVER_NAME};

fn url() -> String {
    format!("http://{BIND_ADDRESS}{MCP_PATH}")
}

fn platform_cmd(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base}.cmd")
    } else {
        base.to_string()
    }
}

fn cmd_succeeds(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run `cmd args...` and check whether its stdout contains the MCP URL.
fn cli_already_configured(cmd: &str, args: &[&str]) -> Result<bool> {
    let output = Command::new(cmd).args(args).output()?;
    if !output.status.success() {
        return Ok(false);
    }
    Ok(String::from_utf8_lossy(&output.stdout).contains(&url()))
}

fn file_already_configured(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    Ok(fs::read_to_string(path)?.contains(&url()))
}

/// Merge into a JSON config file (creating it if missing). Mutator only runs
/// when the file does not already contain our URL.
fn update_json_config(path: &Path, mutator: impl FnOnce(&mut Value)) -> Result<bool> {
    if file_already_configured(path)? {
        return Ok(true);
    }
    let content = fs::read_to_string(path).unwrap_or_else(|_| "{}".to_string());
    let mut json = jsonc_parser::parse_to_serde_value(&content, &Default::default())
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({}));
    mutator(&mut json);
    fs::write(path, serde_json::to_string_pretty(&json)?)?;
    Ok(true)
}

/// Result of attempting to set up a single AI tool.
enum SetupOutcome {
    NotInstalled,
    Configured,
    Failed,
}

fn setup_codex() -> Result<SetupOutcome> {
    let cmd = platform_cmd("codex");
    if !cmd_succeeds(&cmd, &["--version"]) {
        return Ok(SetupOutcome::NotInstalled);
    }
    if cli_already_configured(&cmd, &["mcp", "list"])? {
        return Ok(SetupOutcome::Configured);
    }
    let ok = Command::new(&cmd)
        .args(["mcp", "add", "--url", &url(), SERVER_NAME])
        .status()?
        .success();
    Ok(if ok {
        SetupOutcome::Configured
    } else {
        SetupOutcome::Failed
    })
}

fn setup_claude_code() -> Result<SetupOutcome> {
    let cmd = platform_cmd("claude");
    if !cmd_succeeds(&cmd, &["--version"]) {
        return Ok(SetupOutcome::NotInstalled);
    }
    if cli_already_configured(&cmd, &["mcp", "list"])? {
        return Ok(SetupOutcome::Configured);
    }
    let ok = Command::new(&cmd)
        .args([
            "mcp",
            "add",
            "--transport",
            "http",
            "--scope",
            "user",
            SERVER_NAME,
            &url(),
        ])
        .status()?
        .success();
    Ok(if ok {
        SetupOutcome::Configured
    } else {
        SetupOutcome::Failed
    })
}

fn setup_vscode() -> Result<SetupOutcome> {
    let cmd = platform_cmd("code");
    if !cmd_succeeds(&cmd, &["--version"]) {
        return Ok(SetupOutcome::NotInstalled);
    }
    let config_path = dirs::config_dir()
        .map(|p| p.join("Code/User/mcp.json"))
        .unwrap_or_else(|| PathBuf::from("mcp.json"));
    if file_already_configured(&config_path)? {
        return Ok(SetupOutcome::Configured);
    }
    let arg = format!(
        r#"{{"name":"{SERVER_NAME}","type":"http","url":"{}"}}"#,
        url()
    );
    let ok = Command::new(&cmd)
        .arg("--add-mcp")
        .arg(arg)
        .status()?
        .success();
    Ok(if ok {
        SetupOutcome::Configured
    } else {
        SetupOutcome::Failed
    })
}

fn setup_cursor() -> Result<SetupOutcome> {
    let Some(home) = dirs::home_dir() else {
        return Ok(SetupOutcome::NotInstalled);
    };
    let cursor_dir = home.join(".cursor");
    if !cursor_dir.exists() {
        return Ok(SetupOutcome::NotInstalled);
    }
    let config_path = cursor_dir.join("mcp.json");
    update_json_config(&config_path, |json| {
        if json.get("mcpServers").is_none() {
            json["mcpServers"] = json!({});
        }
        json["mcpServers"][SERVER_NAME] = json!({ "url": url() });
    })?;
    Ok(SetupOutcome::Configured)
}

fn setup_zed() -> Result<SetupOutcome> {
    let Some(home) = dirs::home_dir() else {
        return Ok(SetupOutcome::NotInstalled);
    };
    let config_path = home.join(".config/zed/settings.json");
    if !config_path.exists() {
        return Ok(SetupOutcome::NotInstalled);
    }
    update_json_config(&config_path, |json| {
        if json.get("context_servers").is_none() {
            json["context_servers"] = json!({});
        }
        json["context_servers"][SERVER_NAME] = json!({ "settings": {}, "url": url() });
    })?;
    Ok(SetupOutcome::Configured)
}

pub fn setup_mcp() -> Result<bool> {
    let tools: &[(&str, fn() -> Result<SetupOutcome>)] = &[
        ("Codex", setup_codex),
        ("Claude Code", setup_claude_code),
        ("VS Code", setup_vscode),
        ("Cursor", setup_cursor),
        ("Zed", setup_zed),
    ];

    let mut any_configured = false;
    for (label, setup) in tools {
        match setup() {
            Ok(SetupOutcome::Configured) => {
                any_configured = true;
                println!("MCP configured for {label}");
            }
            Ok(SetupOutcome::Failed) => eprintln!("Failed to configure MCP for {label}"),
            Ok(SetupOutcome::NotInstalled) => {}
            Err(e) => eprintln!("Failed to configure MCP for {label}: {e}"),
        }
    }
    Ok(any_configured)
}

pub fn uninstall_mcp() -> Result<()> {
    uninstall_via_cli("Codex", "codex", &["mcp", "remove", SERVER_NAME]);
    uninstall_via_cli(
        "Claude Code",
        "claude",
        &["mcp", "remove", "--scope", "user", SERVER_NAME],
    );

    let vscode_path = dirs::config_dir().map(|p| p.join("Code/User/mcp.json"));
    if let Some(path) = vscode_path {
        // VS Code's mcp.json may use either "servers" or "mcpServers" depending on
        // version.
        let removed = remove_nested_key(&path, "servers", SERVER_NAME)?
            | remove_nested_key(&path, "mcpServers", SERVER_NAME)?;
        if removed {
            println!("MCP removed for VS Code");
        }
    }

    if let Some(home) = dirs::home_dir() {
        if remove_nested_key(&home.join(".cursor/mcp.json"), "mcpServers", SERVER_NAME)? {
            println!("MCP removed for Cursor");
        }
        if remove_nested_key(
            &home.join(".config/zed/settings.json"),
            "context_servers",
            SERVER_NAME,
        )? {
            println!("MCP removed for Zed");
        }
    }

    Ok(())
}

fn uninstall_via_cli(label: &str, bin: &str, args: &[&str]) {
    // Best-effort: just run the remove command. Failure (CLI absent, entry not
    // configured, exit non-zero) is silently treated as "nothing to do".
    let ok = Command::new(platform_cmd(bin))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        println!("MCP removed for {label}");
    }
}

/// Drop `parent.child` from a JSON config file. Returns true when a key was
/// actually removed (i.e. the file was modified).
fn remove_nested_key(path: &Path, parent: &str, child: &str) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let content = fs::read_to_string(path)?;
    let mut json = jsonc_parser::parse_to_serde_value(&content, &Default::default())
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({}));
    let removed = json
        .get_mut(parent)
        .and_then(|v| v.as_object_mut())
        .is_some_and(|obj| obj.remove(child).is_some());
    if removed {
        fs::write(path, serde_json::to_string_pretty(&json)?)?;
    }
    Ok(removed)
}
