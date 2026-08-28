use std::{collections::HashSet, env, fs, path::PathBuf};

use anyhow::{Context, Result};

use crate::mcp_server::{BrowserMcpServer, TOOL_ROUTING_WORKFLOW};

const SKILL_BODY: &str = include_str!("./skill.md");
const SKILL_NAME: &str = "browser4agent";
const TOOLS_PLACEHOLDER: &str = "{{TOOLS}}";
const BIN_PLACEHOLDER: &str = "{{BIN}}";
const WORKFLOW_PLACEHOLDER: &str = "{{WORKFLOW}}";

/// Each agent's base directory where `skills/<SKILL_NAME>/SKILL.md` lives.
/// Detection is just "the agent's home dir exists" — that's what every CLI in
/// our list creates on first launch and matches vercel-labs/skills's
/// convention.
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
/// itself. `{{WORKFLOW}}` is the same routing guide exposed through MCP server
/// instructions. `{{BIN}}` is replaced with the running binary's absolute path.
pub fn install_skill() -> Result<bool> {
    let body = render_skill();
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

fn render_skill() -> String {
    SKILL_BODY
        .replace(TOOLS_PLACEHOLDER, &render_tools())
        .replace(WORKFLOW_PLACEHOLDER, TOOL_ROUTING_WORKFLOW)
        .replace(BIN_PLACEHOLDER, &current_bin())
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
    // Windows accepts `/` in paths; Git Bash treats unquoted `\` as escapes (`\U`,
    // `\t` in `\target`, etc.). Forward slashes work in both Git Bash and
    // PowerShell, so install one path that is safe everywhere instead of native
    // `\` (PowerShell-only style).
    let path = exe.display().to_string().replace('\\', "/");
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
        } else {
            out.push_str("No description.");
        }
        out.push_str(&format!(
            "\n\nInput: `{}`\n\n",
            render_input_signature(tool.input_schema.as_ref())
        ));
    }
    out.trim_end().to_string()
}

/// Keep the Skill compact: top-level names, requiredness, and primitive types
/// are enough for ordinary calls. The CLI's per-tool help retains the full
/// JSON Schema for nested or otherwise ambiguous values.
fn render_input_signature(schema: &serde_json::Map<String, serde_json::Value>) -> String {
    let Some(properties) = schema.get("properties").and_then(|value| value.as_object()) else {
        return "{}".to_string();
    };
    let required: HashSet<&str> = schema
        .get("required")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .collect();
    let fields = properties
        .iter()
        .map(|(name, field_schema)| {
            let optional = if required.contains(name.as_str()) {
                ""
            } else {
                "?"
            };
            format!("{name}{optional}: {}", compact_schema_type(field_schema))
        })
        .collect::<Vec<_>>();
    if fields.is_empty() {
        return "{}".to_string();
    }
    format!("{{ {} }}", fields.join(", "))
}

fn compact_schema_type(schema: &serde_json::Value) -> String {
    if let Some(kind) = schema.get("type").and_then(|value| value.as_str()) {
        return kind.to_string();
    }
    if let Some(kinds) = schema.get("type").and_then(|value| value.as_array()) {
        let kinds = kinds
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>();
        if !kinds.is_empty() {
            return kinds.join(" | ");
        }
    }
    for keyword in ["oneOf", "anyOf"] {
        if let Some(variants) = schema.get(keyword).and_then(|value| value.as_array()) {
            let kinds = variants.iter().map(compact_schema_type).collect::<Vec<_>>();
            if !kinds.is_empty() {
                return kinds.join(" | ");
            }
        }
    }
    "json".to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        BIN_PLACEHOLDER, SKILL_BODY, TOOL_ROUTING_WORKFLOW, TOOLS_PLACEHOLDER,
        WORKFLOW_PLACEHOLDER, render_input_signature, render_skill,
    };

    #[test]
    fn renders_compact_top_level_input_signature() {
        let schema = json!({
            "type": "object",
            "properties": {
                "tab_id": { "type": "integer" },
                "args": { "type": "array" }
            },
            "required": ["tab_id"]
        });
        assert_eq!(
            render_input_signature(schema.as_object().expect("object schema")),
            "{ tab_id: integer, args?: array }"
        );
    }

    #[test]
    fn generated_skill_uses_shared_workflow_and_replaces_placeholders() {
        assert!(SKILL_BODY.contains(WORKFLOW_PLACEHOLDER));
        let rendered = render_skill();
        assert!(rendered.contains(TOOL_ROUTING_WORKFLOW));
        assert!(rendered.contains("Input: `{}`"));
        assert!(rendered.contains("Input: `{ tab_id: integer }`"));
        assert!(!rendered.contains("Input schema:"));
        assert!(!rendered.contains(TOOLS_PLACEHOLDER));
        assert!(!rendered.contains(WORKFLOW_PLACEHOLDER));
        assert!(!rendered.contains(BIN_PLACEHOLDER));
    }
}
