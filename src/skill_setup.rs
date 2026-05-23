use std::{env, fs, path::PathBuf};

use anyhow::{Context, Result};

use crate::mcp_server::BrowserMcpServer;

const SKILL_BODY: &str = include_str!("./skill.md");
const SKILL_NAME: &str = "browser4agent";
const TOOLS_PLACEHOLDER: &str = "{{TOOLS}}";
const BIN_PLACEHOLDER: &str = "{{BIN}}";

/// Each agent's base directory where `skills/<SKILL_NAME>/SKILL.md` lives.
/// Detection is just "the agent's home dir exists" — that's what every CLI in
/// our list creates on first launch and matches vercel-labs/skills's convention.
fn agents() -> Vec<(&'static str, PathBuf)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut list: Vec<(&'static str, PathBuf)> = [
        ("Codex", home.join(".codex")),
        ("Claude Code", home.join(".claude")),
        ("Cursor", home.join(".cursor")),
    ]
    .into_iter()
    .filter(|(_, base)| base.exists())
    .collect();
    list.push(("Agents", home.join(".agents")));
    list
}

/// Install `SKILL.md` to every detected agent's skills directory.
/// `{{TOOLS}}` is replaced with the live tool list from
/// `BrowserMcpServer::tool_specs()` — same source of truth as the MCP server
/// itself. `{{BIN}}` is replaced with the absolute path of the running binary.
pub fn install_skill() -> Result<bool> {
    let body = SKILL_BODY
        .replace(TOOLS_PLACEHOLDER, &render_tools())
        .replace(BIN_PLACEHOLDER, &current_bin());
    let mut any = false;
    for (label, base) in agents() {
        let path = base.join("skills").join(SKILL_NAME).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        fs::write(&path, &body).with_context(|| format!("failed to write {}", path.display()))?;
        println!("Skill installed for {label}: {}", path.display());
        any = true;
    }
    Ok(any)
}

/// Remove `SKILL.md` from every detected agent's skills directory.
pub fn uninstall_skill() -> Result<()> {
    for (label, base) in agents() {
        let dir = base.join("skills").join(SKILL_NAME);
        let path = dir.join("SKILL.md");
        if path.exists() {
            fs::remove_file(&path)
                .with_context(|| format!("failed to remove {}", path.display()))?;
            // Best-effort: clean up the parent dir if it's now empty.
            let _ = fs::remove_dir(&dir);
            println!("Skill removed for {label}");
        }
    }
    Ok(())
}

fn current_bin() -> String {
    let exe = env::current_exe().unwrap_or_else(|_| PathBuf::from(SKILL_NAME));
    let path = exe.display().to_string();
    if path.contains(char::is_whitespace) {
        format!("\"{path}\"")
    } else {
        path
    }
}

fn render_tools() -> String {
    let mut out = String::new();
    for tool in BrowserMcpServer::tool_specs() {
        out.push_str(&format!("### `{}`\n\n", tool.name));
        if let Some(desc) = &tool.description {
            out.push_str(desc);
            out.push_str("\n\n");
        }
        let has_props = tool
            .input_schema
            .get("properties")
            .and_then(|v| v.as_object())
            .is_some_and(|m| !m.is_empty());
        if has_props {
            let schema = serde_json::to_string_pretty(&*tool.input_schema)
                .unwrap_or_else(|_| "{}".to_string());
            out.push_str("**Input schema:**\n\n```json\n");
            out.push_str(&schema);
            out.push_str("\n```\n\n");
        } else {
            out.push_str("_No parameters._\n\n");
        }
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: `cargo test -- --nocapture dump_rendered_skill` to print the full SKILL.md
    /// that would be written. Not a real assertion.
    #[test]
    #[ignore = "diagnostic only"]
    fn dump_rendered_skill() {
        let rendered = SKILL_BODY
            .replace(TOOLS_PLACEHOLDER, &render_tools())
            .replace(BIN_PLACEHOLDER, &current_bin());
        println!("{rendered}");
    }
}
