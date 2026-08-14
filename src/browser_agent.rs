use std::{path::PathBuf, sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{
    acp_agent::{self, AgentEvent, AgentSessionManager},
    peer::Peer,
};

/// Register the browser-facing agent handlers on the peer.
pub fn register(peer: &Peer) {
    let notify_peer = peer.clone();
    let sessions = AgentSessionManager::new(Some(Arc::new(move |session_id| {
        notify_peer.notify(
            "agent_session_ended",
            json!({ "sessionId": session_id }),
        );
    })));

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
                Ok(Ok(session_id)) => Ok(json!({ "sessionId": session_id })),
                Ok(Err(err)) => Err(err.to_string()),
                Err(_) => Err("Timeout creating ACP agent session".to_string()),
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

    peer.handle("agent_prompt", move |params, ctx| {
        let sessions = sessions.clone();
        async move {
            let prompt = params
                .get("prompt")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "agent_prompt requires a string prompt".to_string())?;
            let cwd = message_cwd(&params);
            let timeout_secs = message_timeout_secs(&params);
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .map(str::to_string);

            // Stream agent events as `{ id, event }` frames while the prompt
            // runs; the forwarder is drained before the final result so no
            // event overtakes the response.
            let forwarder = message_stream(&params).then(|| {
                let (event_tx, mut event_rx) = mpsc::unbounded_channel::<AgentEvent>();
                let ctx = ctx.clone();
                let done = tokio::spawn(async move {
                    while let Some(event) = event_rx.recv().await {
                        let event = serde_json::to_value(&event).unwrap_or(Value::Null);
                        ctx.emit(event);
                    }
                });
                (event_tx, done)
            });
            let event_tx = forwarder.as_ref().map(|(tx, _)| tx.clone());

            let result = if let Some(session_id) = &session_id {
                sessions
                    .prompt(session_id, prompt, timeout_secs, event_tx)
                    .await
            } else {
                match tokio::time::timeout(
                    Duration::from_secs(timeout_secs),
                    acp_agent::ask_stream(prompt, cwd, event_tx),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err(anyhow::anyhow!("Timeout waiting for ACP agent")),
                }
            };

            if let Some((tx, done)) = forwarder {
                drop(tx);
                if result.is_ok() {
                    let _ = done.await;
                }
            }

            result
                .map(|answer| json!({ "answer": answer, "sessionId": session_id }))
                .map_err(|err| err.to_string())
        }
    });
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
