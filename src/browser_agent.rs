use std::path::PathBuf;

use tokio::sync::{mpsc, oneshot};

use crate::{
    acp_agent::{self, AgentSessionManager},
    native_messaging::write_with_request_id,
};

#[derive(Clone)]
pub struct BrowserAgentBridge {
    sessions: AgentSessionManager,
}

impl BrowserAgentBridge {
    pub fn new() -> Self {
        Self {
            sessions: AgentSessionManager::new(),
        }
    }

    pub fn handle_message(&self, msg: serde_json::Value) -> bool {
        match msg.get("type").and_then(|v| v.as_str()) {
            Some("agent_session_create") => {
                self.handle_session_create(msg);
                true
            }
            Some("agent_session_close") => {
                self.handle_session_close(msg);
                true
            }
            Some("agent_prompt") => {
                self.handle_prompt(msg);
                true
            }
            _ => false,
        }
    }

    fn handle_session_create(&self, msg: serde_json::Value) {
        let request_id = request_id(&msg);
        let cwd = message_cwd(&msg);
        let timeout_secs = message_timeout_secs(&msg);
        let sessions = self.sessions.clone();

        tokio::spawn(async move {
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(timeout_secs),
                sessions.create_session(cwd),
            )
            .await;

            match result {
                Ok(Ok(session_id)) => {
                    write_with_request_id(
                        request_id,
                        serde_json::json!({
                            "type": "agent_session_created",
                            "sessionId": session_id
                        }),
                    );
                }
                Ok(Err(err)) => send_error(request_id, err.to_string(), None),
                Err(_) => send_error(
                    request_id,
                    "Timeout creating ACP agent session".to_string(),
                    None,
                ),
            }
        });
    }

    fn handle_session_close(&self, msg: serde_json::Value) {
        let request_id = request_id(&msg);
        let Some(session_id) = msg
            .get("sessionId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
        else {
            send_error(
                request_id,
                "agent_session_close requires a string sessionId".to_string(),
                None,
            );
            return;
        };
        let sessions = self.sessions.clone();

        tokio::spawn(async move {
            let closed = sessions.close_session(&session_id).await;
            write_with_request_id(
                request_id,
                serde_json::json!({
                    "type": "agent_session_closed",
                    "sessionId": session_id,
                    "closed": closed
                }),
            );
        });
    }

    fn handle_prompt(&self, msg: serde_json::Value) {
        let request_id = request_id(&msg);
        let Some(prompt) = msg
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(str::to_string)
        else {
            send_error(
                request_id,
                "agent_prompt requires a string prompt".to_string(),
                None,
            );
            return;
        };
        let cwd = message_cwd(&msg);
        let timeout_secs = message_timeout_secs(&msg);
        let stream = message_stream(&msg);
        let session_id = msg
            .get("sessionId")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let event_forwarder =
            stream.then(|| forward_agent_events(request_id.clone(), session_id.clone()));
        let event_tx = event_forwarder
            .as_ref()
            .map(|forwarder| forwarder.tx.clone());
        let sessions = self.sessions.clone();

        tokio::spawn(async move {
            let result = if let Some(session_id) = &session_id {
                sessions
                    .prompt(session_id, prompt, timeout_secs, event_tx)
                    .await
            } else {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(timeout_secs),
                    acp_agent::ask_stream(prompt, cwd, event_tx),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err(anyhow::anyhow!("Timeout waiting for ACP agent")),
                }
            };

            drain_forwarder_after_result(&result, event_forwarder).await;

            match result {
                Ok(answer) => {
                    write_with_request_id(
                        request_id,
                        serde_json::json!({
                            "type": "agent_response",
                            "answer": answer,
                            "sessionId": session_id
                        }),
                    );
                }
                Err(err) => send_error(request_id, err.to_string(), session_id),
            }
        });
    }
}

struct AgentEventForwarder {
    tx: mpsc::UnboundedSender<acp_agent::AgentEvent>,
    done: oneshot::Receiver<()>,
}

fn forward_agent_events(
    request_id: Option<serde_json::Value>,
    session_id: Option<String>,
) -> AgentEventForwarder {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let (done_tx, done_rx) = oneshot::channel();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            write_with_request_id(
                request_id.clone(),
                serde_json::json!({
                    "type": "agent_event",
                    "sessionId": session_id.clone(),
                    "data": event
                }),
            );
        }
        let _ = done_tx.send(());
    });
    AgentEventForwarder {
        tx: event_tx,
        done: done_rx,
    }
}

async fn drain_forwarder_after_result(
    result: &anyhow::Result<String>,
    forwarder: Option<AgentEventForwarder>,
) {
    let Some(forwarder) = forwarder else {
        return;
    };
    drop(forwarder.tx);

    if result.is_ok() {
        let _ = forwarder.done.await;
    }
}

fn send_error(request_id: Option<serde_json::Value>, error: String, session_id: Option<String>) {
    write_with_request_id(
        request_id,
        serde_json::json!({
            "type": "agent_error",
            "error": error,
            "sessionId": session_id
        }),
    );
}

fn request_id(msg: &serde_json::Value) -> Option<serde_json::Value> {
    msg.get("request_id").cloned()
}

fn message_cwd(msg: &serde_json::Value) -> Option<PathBuf> {
    msg.get("cwd")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn message_timeout_secs(msg: &serde_json::Value) -> u64 {
    msg.get("timeoutSeconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(600)
        .clamp(1, 3600)
}

fn message_stream(msg: &serde_json::Value) -> bool {
    msg.get("stream").and_then(|v| v.as_bool()).unwrap_or(false)
}
