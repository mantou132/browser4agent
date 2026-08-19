use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{
    acp_agent::{self, AgentEvent, AgentSessionManager},
    logger,
    peer::{CallCtx, Peer},
};

/// Stream agent events as `{ id, event }` frames while a request runs.
fn event_forwarder(
    ctx: &CallCtx,
) -> (
    mpsc::UnboundedSender<AgentEvent>,
    tokio::task::JoinHandle<()>,
) {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<AgentEvent>();
    let ctx = ctx.clone();
    let done = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let event = serde_json::to_value(&event).unwrap_or(Value::Null);
            ctx.emit(event);
        }
    });
    (event_tx, done)
}

/// Drop the event sender and wait for the forwarder to drain so streamed
/// events never overtake the final result.
async fn settle_forwarder(
    forwarder: Option<(
        mpsc::UnboundedSender<AgentEvent>,
        tokio::task::JoinHandle<()>,
    )>,
    ok: bool,
) {
    if let Some((tx, done)) = forwarder {
        drop(tx);
        if ok {
            let _ = done.await;
        }
    }
}

/// Register the browser-facing agent handlers on the peer.
pub fn register(peer: &Peer) {
    let notify_peer = peer.clone();
    let permission_peer = peer.clone();
    // Forward ACP permission requests to the extension and await the option
    // the user picked; anything but an option id cancels the tool call.
    let resolver: acp_agent::PermissionResolver = Arc::new(move |request| {
        let peer = permission_peer.clone();
        Box::pin(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(300),
                peer.call("agent_permission_request", request),
            )
            .await;
            match result {
                Ok(Ok(response)) => response
                    .get("optionId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                Ok(Err(err)) => {
                    logger::log(&format!("Permission request declined: {err}"));
                    None
                }
                Err(_) => {
                    logger::log("Permission request timed out");
                    None
                }
            }
        })
    });
    let sessions = AgentSessionManager::new(
        Some(Arc::new(move |session_id| {
            notify_peer.notify("agent_session_ended", json!({ "sessionId": session_id }));
        })),
        Some(resolver.clone()),
    );

    peer.handle("agent_cwd_complete", move |params, _ctx| async move {
        let input = params
            .get("input")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let limit = params
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(100)
            .clamp(1, 200) as usize;
        tokio::task::spawn_blocking(move || complete_directories(&input, limit))
            .await
            .map_err(|err| format!("Directory completion task failed: {err}"))?
    });

    let create_sessions = sessions.clone();
    peer.handle("agent_session_create", move |params, _ctx| {
        let sessions = create_sessions.clone();
        async move {
            let cwd = message_cwd(&params);
            let system_prompt = message_panel_system_prompt(&params)?;
            let timeout_secs = message_timeout_secs(&params);
            match tokio::time::timeout(
                Duration::from_secs(timeout_secs),
                sessions.create_session(cwd, system_prompt),
            )
            .await
            {
                Ok(Ok(created)) => Ok(json!({
                    "sessionId": created.session_id,
                    "modes": created.modes,
                    "configOptions": created.config_options,
                })),
                Ok(Err(err)) => Err(err.to_string()),
                Err(_) => Err("Timeout creating ACP agent session".to_string()),
            }
        }
    });

    let load_sessions = sessions.clone();
    peer.handle("agent_session_load", move |params, ctx| {
        let sessions = load_sessions.clone();
        async move {
            let acp_session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "agent_session_load requires a string sessionId".to_string())?;
            let cwd = message_cwd(&params);
            let system_prompt = message_panel_system_prompt(&params)?;
            let timeout_secs = message_timeout_secs(&params);

            // The actor drains the load-time history replay into this channel
            // while the load runs; afterwards the buffered frames are emitted
            // (receiver closed, so the actor's live sender can't keep it open)
            // before the final result, so history precedes the response.
            let (replay_tx, mut event_rx) = if message_stream(&params) {
                let (tx, rx) = mpsc::unbounded_channel::<AgentEvent>();
                (Some(tx), Some(rx))
            } else {
                (None, None)
            };

            let result = match tokio::time::timeout(
                Duration::from_secs(timeout_secs),
                sessions.load_session(acp_session_id, cwd, system_prompt, replay_tx),
            )
            .await
            {
                Ok(Ok(created)) => Ok(json!({
                    "sessionId": created.session_id,
                    "modes": created.modes,
                    "configOptions": created.config_options,
                })),
                Ok(Err(err)) => Err(err.to_string()),
                Err(_) => Err("Timeout loading ACP agent session".to_string()),
            };

            if let Some(rx) = event_rx.as_mut() {
                rx.close();
                while let Some(event) = rx.recv().await {
                    let event = serde_json::to_value(&event).unwrap_or(Value::Null);
                    ctx.emit(event);
                }
            }
            result
        }
    });

    let list_sessions = sessions.clone();
    peer.handle("agent_session_list", move |params, _ctx| {
        let sessions = list_sessions.clone();
        async move {
            let cwd = message_cwd(&params);
            let cursor = params
                .get("cursor")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .map(str::to_string);
            let timeout_secs = message_timeout_secs(&params);
            match tokio::time::timeout(
                Duration::from_secs(timeout_secs),
                sessions.list_sessions(cwd, cursor),
            )
            .await
            {
                Ok(Ok(list)) => Ok(list),
                Ok(Err(err)) => Err(err.to_string()),
                Err(_) => Err("Timeout listing ACP agent sessions".to_string()),
            }
        }
    });

    let delete_sessions = sessions.clone();
    peer.handle("agent_session_delete", move |params, _ctx| {
        let sessions = delete_sessions.clone();
        async move {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "agent_session_delete requires a string sessionId".to_string())?;
            let timeout_secs = message_timeout_secs(&params);
            match tokio::time::timeout(
                Duration::from_secs(timeout_secs),
                sessions.delete_session(session_id),
            )
            .await
            {
                Ok(Ok(())) => Ok(json!({ "sessionId": session_id, "deleted": true })),
                Ok(Err(err)) => Err(err.to_string()),
                Err(_) => Err("Timeout deleting ACP agent session".to_string()),
            }
        }
    });

    let close_sessions = sessions.clone();
    peer.handle("agent_session_close", move |params, _ctx| {
        let sessions = close_sessions.clone();
        async move {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "agent_session_close requires a string sessionId".to_string())?;
            let closed = sessions.close_session(session_id).await;
            Ok(json!({ "sessionId": session_id, "closed": closed }))
        }
    });

    let cancel_sessions = sessions.clone();
    peer.handle("agent_prompt_cancel", move |params, _ctx| {
        let sessions = cancel_sessions.clone();
        async move {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "agent_prompt_cancel requires a string sessionId".to_string())?;
            let cancelled = sessions.cancel(session_id).await;
            Ok(json!({ "sessionId": session_id, "cancelled": cancelled }))
        }
    });

    let prompt_sessions = sessions.clone();
    peer.handle("agent_prompt", move |params, ctx| {
        let sessions = prompt_sessions.clone();
        async move {
            let prompt = params
                .get("prompt")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "agent_prompt requires a string prompt".to_string())?;
            let timeout_secs = message_timeout_secs(&params);
            let attachments = message_attachments(&params)?;
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "agent_prompt requires a string sessionId".to_string())?;

            // Stream agent events as `{ id, event }` frames while the prompt
            // runs; the forwarder is drained before the final result so no
            // event overtakes the response.
            let forwarder = message_stream(&params).then(|| event_forwarder(&ctx));
            let event_tx = forwarder.as_ref().map(|(tx, _)| tx.clone());

            let result = sessions
                .prompt(session_id, prompt, attachments, timeout_secs, event_tx)
                .await;

            settle_forwarder(forwarder, result.is_ok()).await;

            result
                .map(|answer| json!({ "answer": answer, "sessionId": session_id }))
                .map_err(|err| err.to_string())
        }
    });

    let mode_sessions = sessions.clone();
    peer.handle("agent_session_set_mode", move |params, _ctx| {
        let sessions = mode_sessions.clone();
        async move {
            let session_id = required_session_id(&params, "agent_session_set_mode")?;
            let mode_id = params
                .get("modeId")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "agent_session_set_mode requires a string modeId".to_string())?;
            sessions
                .set_mode(session_id, mode_id)
                .await
                .map(|_| json!({}))
                .map_err(|err| err.to_string())
        }
    });

    let config_sessions = sessions.clone();
    peer.handle("agent_session_set_config_option", move |params, _ctx| {
        let sessions = config_sessions.clone();
        async move {
            let session_id = required_session_id(&params, "agent_session_set_config_option")?;
            let config_id = params
                .get("configId")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    "agent_session_set_config_option requires a string configId".to_string()
                })?;
            let value = params
                .get("value")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    "agent_session_set_config_option requires a string value".to_string()
                })?;
            sessions
                .set_config_option(session_id, config_id, value)
                .await
                .map(|_| json!({}))
                .map_err(|err| err.to_string())
        }
    });
}

fn complete_directories(input: &str, limit: usize) -> Result<Value, String> {
    let current_dir = std::env::current_dir()
        .map_err(|err| format!("Failed to resolve current directory: {err}"))?;
    let base_dir = dirs::home_dir().unwrap_or_else(|| current_dir.clone());
    let input = input.trim();
    let path = resolve_directory_path(input, &base_dir);
    let is_directory = path.is_dir();
    let (directory, prefix) = if is_directory {
        (path.clone(), String::new())
    } else {
        let directory = path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(&base_dir)
            .to_path_buf();
        let prefix = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        (directory, prefix)
    };

    let prefix = prefix.to_lowercase();
    let mut directories = std::fs::read_dir(&directory)
        .map_err(|err| format!("Failed to read {}: {err}", directory.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter(|entry| {
            prefix.is_empty()
                || entry
                    .file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with(&prefix)
        })
        .map(|entry| entry.path().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    directories.sort_by_key(|path| path.to_lowercase());
    directories.truncate(limit);

    Ok(json!({
        "value": path.to_string_lossy(),
        "isDirectory": is_directory,
        "directories": directories,
    }))
}

fn resolve_directory_path(input: &str, base_dir: &Path) -> PathBuf {
    if input.is_empty() || input == "~" {
        base_dir.to_path_buf()
    } else if let Some(relative) = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
    {
        base_dir.join(relative)
    } else {
        let path = PathBuf::from(input);
        if path.is_absolute() {
            path
        } else {
            base_dir.join(path)
        }
    }
}

fn required_session_id<'a>(params: &'a Value, method: &str) -> Result<&'a str, String> {
    params
        .get("sessionId")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{method} requires a string sessionId"))
}

fn message_cwd(params: &Value) -> Option<PathBuf> {
    params
        .get("cwd")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn message_panel_system_prompt(params: &Value) -> Result<Option<String>, String> {
    let Some(context) = params.get("panelContext") else {
        return Ok(None);
    };
    let surface = context
        .get("surface")
        .and_then(Value::as_str)
        .ok_or_else(|| "panelContext.surface must be a string".to_string())?;
    match surface {
        "devtools" => {
            let tab_id = context
                .get("tabId")
                .and_then(Value::as_u64)
                .ok_or_else(|| "DevTools panelContext requires a numeric tabId".to_string())?;
            Ok(Some(format!(
                "You are running inside browser4agent's Agent panel in browser DevTools. This \
                 DevTools instance is attached to browser tab ID {tab_id}. Treat that inspected \
                 tab as the primary target for browser-related requests. For browser tools that \
                 accept a tabId, use {tab_id}; do not substitute the globally active tab unless \
                 the user explicitly asks you to. Read the inspected tab before acting when page \
                 context is needed, and prefer a suitable page-provided tool returned by read_tab."
            )))
        }
        "side_panel" => Ok(Some(
            "You are running inside browser4agent's browser sidebar Agent panel. Treat the \
             currently active browser tab as the primary target for browser-related requests. The \
             active tab may change during this session, so resolve it with read_active_tab at the \
             start of each browser task and use the returned tabId for related actions. Prefer a \
             suitable page-provided tool returned by read_active_tab."
                .to_string(),
        )),
        _ => Err(format!("unknown panelContext.surface: {surface}")),
    }
}

fn message_timeout_secs(params: &Value) -> u64 {
    params
        .get("timeoutSeconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(600)
        .clamp(1, 3600)
}

fn message_stream(params: &Value) -> bool {
    params
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn message_attachments(params: &Value) -> Result<Vec<acp_agent::Attachment>, String> {
    let Some(items) = params.get("attachments").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };
    items
        .iter()
        .map(|item| match item.get("type").and_then(|v| v.as_str()) {
            Some("image") => {
                let data = item
                    .get("data")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| "image attachment requires base64 data".to_string())?;
                let mime_type = item
                    .get("mimeType")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                    .unwrap_or("image/png");
                Ok(acp_agent::Attachment::Image {
                    data: data.to_string(),
                    mime_type: mime_type.to_string(),
                })
            }
            Some("resource") => {
                let uri = item
                    .get("uri")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| "resource attachment requires a uri".to_string())?;
                let name = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| "resource attachment requires a name".to_string())?;
                let mime_type = item
                    .get("mimeType")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                    .map(str::to_string);
                Ok(acp_agent::Attachment::Resource {
                    uri: uri.to_string(),
                    name: name.to_string(),
                    mime_type,
                })
            }
            other => Err(format!("unknown attachment type: {other:?}")),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{complete_directories, message_panel_system_prompt, resolve_directory_path};

    #[test]
    fn builds_devtools_panel_system_prompt() {
        let prompt = message_panel_system_prompt(&serde_json::json!({
            "panelContext": { "surface": "devtools", "tabId": 42 }
        }))
        .expect("valid panel context")
        .expect("system prompt");

        assert!(prompt.contains("browser DevTools"));
        assert!(prompt.contains("tab ID 42"));
        assert!(prompt.contains("use 42"));
    }

    #[test]
    fn builds_side_panel_system_prompt() {
        let prompt = message_panel_system_prompt(&serde_json::json!({
            "panelContext": { "surface": "side_panel" }
        }))
        .expect("valid panel context")
        .expect("system prompt");

        assert!(prompt.contains("browser sidebar"));
        assert!(prompt.contains("read_active_tab"));
    }

    #[test]
    fn completes_and_validates_directories() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("browser4agent-cwd-{unique}"));
        let alpha = root.join("alpha");
        let alpine = root.join("alpine");
        std::fs::create_dir_all(&alpha).expect("create alpha directory");
        std::fs::create_dir_all(&alpine).expect("create alpine directory");

        let prefix = root.join("al").to_string_lossy().into_owned();
        let completion = complete_directories(&prefix, 100).expect("complete directory prefix");
        let exact =
            complete_directories(&alpha.to_string_lossy(), 100).expect("validate exact directory");
        std::fs::remove_dir_all(&root).expect("remove test directory");

        assert_eq!(completion["isDirectory"], false);
        assert_eq!(completion["directories"].as_array().map(Vec::len), Some(2));
        assert_eq!(exact["isDirectory"], true);
    }

    #[test]
    fn expands_home_directory_shorthand() {
        let home = PathBuf::from("home").join("user");

        assert_eq!(resolve_directory_path("~", &home), home);
        assert_eq!(resolve_directory_path("~/test", &home), home.join("test"));
        assert_eq!(resolve_directory_path("~\\test", &home), home.join("test"));
    }
}
