use std::{path::PathBuf, sync::Arc, time::Duration};

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
    forwarder: Option<(mpsc::UnboundedSender<AgentEvent>, tokio::task::JoinHandle<()>)>,
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
            notify_peer.notify(
                "agent_session_ended",
                json!({ "sessionId": session_id }),
            );
        })),
        Some(resolver.clone()),
    );

    let create_sessions = sessions.clone();
    peer.handle("agent_session_create", move |params, _ctx| {
        let sessions = create_sessions.clone();
        async move {
            let cwd = message_cwd(&params);
            let timeout_secs = message_timeout_secs(&params);
            match tokio::time::timeout(
                Duration::from_secs(timeout_secs),
                sessions.create_session(cwd),
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
                sessions.load_session(acp_session_id, cwd, replay_tx),
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

    peer.handle("agent_session_list", move |params, _ctx| async move {
        let cwd = message_cwd(&params);
        let cursor = params
            .get("cursor")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let timeout_secs = message_timeout_secs(&params);
        match tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            acp_agent::list_sessions(cwd, cursor),
        )
        .await
        {
            Ok(Ok(list)) => Ok(list),
            Ok(Err(err)) => Err(err.to_string()),
            Err(_) => Err("Timeout listing ACP agent sessions".to_string()),
        }
    });

    peer.handle("agent_session_delete", move |params, _ctx| {
        async move {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "agent_session_delete requires a string sessionId".to_string())?;
            let timeout_secs = message_timeout_secs(&params);
            match tokio::time::timeout(
                Duration::from_secs(timeout_secs),
                acp_agent::delete_session(session_id),
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
        let resolver = resolver.clone();
        async move {
            let prompt = params
                .get("prompt")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "agent_prompt requires a string prompt".to_string())?;
            let cwd = message_cwd(&params);
            let timeout_secs = message_timeout_secs(&params);
            let attachments = message_attachments(&params)?;
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .map(str::to_string);

            // Stream agent events as `{ id, event }` frames while the prompt
            // runs; the forwarder is drained before the final result so no
            // event overtakes the response.
            let forwarder = message_stream(&params).then(|| event_forwarder(&ctx));
            let event_tx = forwarder.as_ref().map(|(tx, _)| tx.clone());

            let result = if let Some(session_id) = &session_id {
                sessions
                    .prompt(session_id, prompt, attachments, timeout_secs, event_tx)
                    .await
            } else {
                match tokio::time::timeout(
                    Duration::from_secs(timeout_secs),
                    acp_agent::ask_stream(prompt, attachments, cwd, Some(resolver), event_tx),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err(anyhow::anyhow!("Timeout waiting for ACP agent")),
                }
            };

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
