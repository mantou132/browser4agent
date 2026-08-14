use std::{collections::HashMap, path::PathBuf, sync::Arc};

use agent_client_protocol::{
    AcpAgent, ActiveSession, Agent, Client, ConnectionTo, SessionMessage,
    schema::{
        ProtocolVersion,
        v1::{
            CancelNotification, ContentBlock, ContentChunk, InitializeRequest,
            RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
            SessionNotification, SessionUpdate,
        },
    },
    util::MatchDispatch,
};
use anyhow::{Context, Result};
use serde::Serialize;
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::logger;

#[cfg(windows)]
fn claude_agent_command() -> Vec<&'static str> {
    vec![
        "cmd",
        "/C",
        "npx",
        "-y",
        "@agentclientprotocol/claude-agent-acp",
    ]
}

#[cfg(not(windows))]
fn claude_agent_command() -> Vec<&'static str> {
    vec!["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
}

fn resolve_cwd(cwd: Option<PathBuf>) -> Result<PathBuf> {
    match cwd {
        Some(cwd) => Ok(cwd),
        None => std::env::current_dir().context("failed to resolve current directory"),
    }
}

/// Spawn the ACP agent subprocess, initialize a session in `cwd`, and run
/// `op` with it. Shared by one-shot prompts and persistent sessions.
async fn with_agent_session<F, T>(cwd: PathBuf, op: F) -> Result<T>
where
    F: for<'responder> AsyncFnOnce(
        ActiveSession<'responder, Agent>,
    ) -> Result<T, agent_client_protocol::Error>,
{
    let command = claude_agent_command();
    logger::info(&format!("Starting ACP agent: {}", command.join(" ")));
    let agent = AcpAgent::from_args(command).context("failed to configure ACP agent command")?;

    Client
        .builder()
        .name("browser4agent")
        .on_receive_request(
            async move |_request: RequestPermissionRequest, responder, _connection| {
                logger::info("Cancelled ACP permission request because no browser UI is available");
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;

            connection.build_session(cwd).block_task().run_until(op).await
        })
        .await
        .context("ACP agent request failed")
}

pub async fn ask_stream(
    prompt: String,
    cwd: Option<PathBuf>,
    event_tx: Option<mpsc::UnboundedSender<AgentEvent>>,
) -> Result<String> {
    let cwd = resolve_cwd(cwd)?;
    with_agent_session(cwd, async move |mut session| {
        run_prompt(&mut session, prompt, event_tx).await
    })
    .await
}

/// Stream events forwarded to the extension. `update` is the raw ACP session
/// update payload (text chunks included); `stop` terminates the prompt.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum AgentEvent {
    SessionUpdate { update: serde_json::Value },
    Stop { stop_reason: serde_json::Value },
}

pub type SessionEndCallback = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct AgentSessionManager {
    sessions: Arc<Mutex<HashMap<String, AgentSession>>>,
    next_id: Arc<Mutex<u64>>,
    /// Invoked with the session id whenever a session actor exits, whether
    /// closed on purpose, cancelled, or died with the subprocess.
    on_end: Option<SessionEndCallback>,
}

#[derive(Clone)]
struct AgentSession {
    tx: mpsc::Sender<SessionCommand>,
}

enum SessionCommand {
    Prompt {
        prompt: String,
        event_tx: Option<mpsc::UnboundedSender<AgentEvent>>,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Cancel,
    Close,
}

impl AgentSessionManager {
    pub fn new(on_end: Option<SessionEndCallback>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(0)),
            on_end,
        }
    }

    pub async fn create_session(&self, cwd: Option<PathBuf>) -> Result<String> {
        let mut next_id = self.next_id.lock().await;
        *next_id += 1;
        let session_id = format!("agent-session-{}", *next_id);
        drop(next_id);

        let cwd = resolve_cwd(cwd)?;
        let (tx, rx) = mpsc::channel(8);
        let (ready_tx, ready_rx) = oneshot::channel();
        let sessions = self.sessions.clone();
        let on_end = self.on_end.clone();
        let actor_session_id = session_id.clone();
        tokio::spawn(async move {
            run_session_actor(actor_session_id.clone(), cwd, rx, ready_tx).await;
            // The actor exited (closed, or the subprocess died): drop the
            // handle so later calls fail fast, and report the session gone.
            sessions.lock().await.remove(&actor_session_id);
            if let Some(on_end) = on_end {
                on_end(&actor_session_id);
            }
        });

        // Readiness is bounded by the caller's timeout, not here.
        match ready_rx.await {
            Ok(Ok(())) => {
                self.sessions
                    .lock()
                    .await
                    .insert(session_id.clone(), AgentSession { tx });
                Ok(session_id)
            }
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP agent session stopped before it was ready"),
        }
    }

    pub async fn prompt(
        &self,
        session_id: &str,
        prompt: String,
        timeout_secs: u64,
        event_tx: Option<mpsc::UnboundedSender<AgentEvent>>,
    ) -> Result<String> {
        let session = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .with_context(|| format!("Unknown agent session: {session_id}"))?;

        let (reply_tx, reply_rx) = oneshot::channel();
        session
            .tx
            .send(SessionCommand::Prompt {
                prompt,
                event_tx,
                reply: reply_tx,
            })
            .await
            .context("ACP agent session is closed")?;

        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), reply_rx).await {
            Ok(Ok(Ok(answer))) => Ok(answer),
            Ok(Ok(Err(err))) => anyhow::bail!(err),
            Ok(Err(_)) => anyhow::bail!("ACP agent session closed before responding"),
            Err(_) => anyhow::bail!("Timeout waiting for ACP agent"),
        }
    }

    /// Cancel the in-flight prompt of a session. The prompt settles with the
    /// partial answer and a `stop` event carrying the cancel reason.
    pub async fn cancel(&self, session_id: &str) -> bool {
        let Some(session) = self.sessions.lock().await.get(session_id).cloned() else {
            return false;
        };
        session.tx.send(SessionCommand::Cancel).await.is_ok()
    }

    pub async fn close_session(&self, session_id: &str) -> bool {
        let Some(session) = self.sessions.lock().await.remove(session_id) else {
            return false;
        };
        let _ = session.tx.send(SessionCommand::Close).await;
        true
    }
}

async fn run_session_actor(
    session_id: String,
    cwd: PathBuf,
    rx: mpsc::Receiver<SessionCommand>,
    ready_tx: oneshot::Sender<Result<(), String>>,
) {
    if let Err(err) = run_session_actor_inner(cwd, rx, ready_tx).await {
        logger::info(&format!("ACP session {session_id} stopped: {err}"));
    }
}

async fn run_session_actor_inner(
    cwd: PathBuf,
    mut rx: mpsc::Receiver<SessionCommand>,
    ready_tx: oneshot::Sender<Result<(), String>>,
) -> Result<()> {
    let ready_tx = Arc::new(std::sync::Mutex::new(Some(ready_tx)));
    let ready_tx_for_session = ready_tx.clone();

    let result = with_agent_session(cwd, async move |mut session| {
        if let Some(ready_tx) = ready_tx_for_session.lock().ok().and_then(|mut tx| tx.take()) {
            let _ = ready_tx.send(Ok(()));
        }
        while let Some(command) = rx.recv().await {
            match command {
                SessionCommand::Prompt {
                    prompt,
                    event_tx,
                    reply,
                } => {
                    let result = run_prompt(&mut session, prompt, event_tx)
                        .await
                        .map_err(|err| err.to_string());
                    let _ = reply.send(result);
                }
                SessionCommand::Cancel => {
                    let notification = CancelNotification::new(session.session_id().clone());
                    if let Err(err) = session.connection().send_notification(notification) {
                        logger::info(&format!("Failed to cancel ACP session: {err}"));
                    }
                }
                SessionCommand::Close => break,
            }
        }
        Ok(())
    })
    .await;

    if let Err(err) = result {
        if let Some(ready_tx) = ready_tx.lock().ok().and_then(|mut tx| tx.take()) {
            let _ = ready_tx.send(Err(err.to_string()));
        }
        anyhow::bail!("ACP agent session failed: {err}");
    }

    Ok(())
}

async fn run_prompt(
    session: &mut ActiveSession<'_, Agent>,
    prompt: String,
    event_tx: Option<mpsc::UnboundedSender<AgentEvent>>,
) -> Result<String, agent_client_protocol::Error> {
    session.send_prompt(prompt)?;
    let mut answer = String::new();
    loop {
        match session.read_update().await? {
            SessionMessage::SessionMessage(dispatch) => {
                MatchDispatch::new(dispatch)
                    .if_notification(async |notif: SessionNotification| {
                        handle_session_update(notif.update, &mut answer, event_tx.as_ref())?;
                        Ok(())
                    })
                    .await
                    .otherwise_ignore()?;
            }
            SessionMessage::StopReason(stop_reason) => {
                send_agent_event(
                    event_tx.as_ref(),
                    AgentEvent::Stop {
                        stop_reason: to_json(stop_reason),
                    },
                );
                break;
            }
            _ => {}
        }
    }
    Ok(answer)
}

fn handle_session_update(
    update: SessionUpdate,
    answer: &mut String,
    event_tx: Option<&mpsc::UnboundedSender<AgentEvent>>,
) -> Result<(), agent_client_protocol::Error> {
    if let SessionUpdate::AgentMessageChunk(ContentChunk {
        content: ContentBlock::Text(text),
        ..
    }) = &update
    {
        answer.push_str(&text.text);
    }

    send_agent_event(
        event_tx,
        AgentEvent::SessionUpdate {
            update: to_json(update),
        },
    );
    Ok(())
}

fn send_agent_event(event_tx: Option<&mpsc::UnboundedSender<AgentEvent>>, event: AgentEvent) {
    if let Some(event_tx) = event_tx {
        let _ = event_tx.send(event);
    }
}

fn to_json(value: impl Serialize) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or_else(|err| {
        serde_json::json!({
            "serializationError": err.to_string()
        })
    })
}
