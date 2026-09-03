use std::{
    collections::{HashMap, VecDeque},
    future,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use agent_client_protocol::{
    AcpAgent, ActiveSession, Agent, Client, ConnectionTo, SessionMessage,
    schema::{
        ProtocolVersion,
        v1::{
            CancelNotification, CloseSessionRequest, ContentBlock, ContentChunk,
            DeleteSessionRequest, ImageContent, InitializeRequest, ListSessionsRequest,
            LoadSessionRequest, NewSessionRequest, NewSessionResponse, PermissionOptionId,
            PromptRequest, PromptResponse, RequestPermissionOutcome, RequestPermissionRequest,
            RequestPermissionResponse, ResourceLink, SelectedPermissionOutcome, SessionConfigId,
            SessionConfigValueId, SessionId, SessionModeId, SessionNotification, SessionUpdate,
            SetSessionConfigOptionRequest, SetSessionModeRequest, TextContent,
        },
    },
    util::MatchDispatch,
};
use anyhow::{Context, Result};
use serde::Serialize;
use tokio::sync::{Mutex, mpsc, oneshot, watch};

use crate::{logger, peer::BoxFuture};

mod catalog;
mod provision;

pub use catalog::available_agents;
use catalog::{AgentCandidate, agent_candidates};
use provision::prepare_agent_command;

fn resolve_cwd(cwd: Option<PathBuf>) -> Result<PathBuf> {
    match cwd {
        Some(cwd) => Ok(cwd),
        None => std::env::current_dir().context("failed to resolve current directory"),
    }
}

/// Resolve an ACP permission request (forwarded as JSON with `sessionId`,
/// `toolCall`, `options`) to the id of the option the user picked.
/// `None` cancels the pending tool call.
pub type PermissionResolver =
    Arc<dyn Fn(serde_json::Value) -> BoxFuture<'static, Option<String>> + Send + Sync>;

/// Snapshot returned after an ACP session actor is ready.
pub struct SessionReady {
    pub session_id: String,
    /// Human-readable title reported while creating/loading the session.
    pub title: Option<String>,
    /// ISO timestamp reported while creating/loading the session.
    pub updated_at: Option<String>,
    /// Modes the agent supports for this session (for `set_mode`).
    pub modes: Option<serde_json::Value>,
    /// Config options the agent supports for this session (for
    /// `set_config_option`).
    pub config_options: Option<serde_json::Value>,
}

/// Lazily starts one ACP subprocess and shares its connection across sessions.
/// A failed connection is discarded and started again on the next API call.
struct RuntimeState {
    connection: Option<ConnectionTo<Agent>>,
    connecting: bool,
    generation: u64,
    waiters: Vec<oneshot::Sender<Result<ConnectionTo<Agent>, String>>>,
}

#[derive(Clone)]
struct AcpRuntime {
    agent: String,
    candidate: AgentCandidate,
    state: Arc<Mutex<RuntimeState>>,
    session_resolvers: Arc<Mutex<HashMap<String, PermissionResolver>>>,
    permission_cancels: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    disconnects: watch::Sender<u64>,
}

impl AcpRuntime {
    fn new(candidate: AgentCandidate) -> Self {
        let (disconnects, _) = watch::channel(0);
        Self {
            agent: candidate.id.to_string(),
            candidate,
            state: Arc::new(Mutex::new(RuntimeState {
                connection: None,
                connecting: false,
                generation: 0,
                waiters: Vec::new(),
            })),
            session_resolvers: Arc::new(Mutex::new(HashMap::new())),
            permission_cancels: Arc::new(Mutex::new(HashMap::new())),
            disconnects,
        }
    }

    async fn connection(&self) -> Result<ConnectionTo<Agent>> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let generation = {
            let mut state = self.state.lock().await;
            if let Some(connection) = &state.connection {
                return Ok(connection.clone());
            }
            state.waiters.push(reply_tx);
            if state.connecting {
                None
            } else {
                state.connecting = true;
                state.generation += 1;
                Some(state.generation)
            }
        };
        if let Some(generation) = generation {
            self.spawn_connection(generation);
        }
        match reply_rx.await {
            Ok(Ok(connection)) => Ok(connection),
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP runtime stopped while connecting"),
        }
    }

    fn spawn_connection(&self, generation: u64) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let result = runtime.serve_connection(generation).await;
            let error = result
                .err()
                .map(|err| err.to_string())
                .unwrap_or_else(|| "ACP agent connection stopped".to_string());
            logger::info(&error);
            runtime.connection_stopped(generation, error).await;
        });
    }

    async fn serve_connection(&self, generation: u64) -> Result<()> {
        let candidate = self.candidate;
        let command = tokio::task::spawn_blocking(move || prepare_agent_command(candidate))
            .await
            .context("ACP runtime preparation task failed")??;
        logger::info(&format!(
            "Starting {} ACP agent: {}",
            self.agent,
            command.join(" ")
        ));
        // `from_args` treats leading `NAME=value` args as env overrides for the
        // spawned subprocess.
        let acp_agent =
            AcpAgent::from_args(command).context("failed to configure ACP agent command")?;
        let session_resolvers = self.session_resolvers.clone();
        let permission_cancels = self.permission_cancels.clone();
        let runtime = self.clone();
        let agent_id = self.agent.clone();

        Client
            .builder()
            .name("browser4agent")
            .on_receive_request(
                async move |request: RequestPermissionRequest, responder, connection| {
                    let session_resolvers = session_resolvers.clone();
                    let permission_cancels = permission_cancels.clone();
                    let agent_id = agent_id.clone();
                    connection.spawn(async move {
                        let session_id = request.session_id.to_string();
                        let payload = serde_json::json!({
                            "agent": agent_id,
                            "sessionId": session_id,
                            "toolCall": to_json(request.tool_call),
                            "options": to_json(request.options),
                        });
                        let resolver = session_resolvers.lock().await.get(&session_id).cloned();
                        let cancel = permission_cancels.lock().await.get(&session_id).cloned();
                        let resolution = match (resolver, cancel) {
                            (Some(resolver), Some(cancel)) => {
                                let mut cancel_rx = cancel.subscribe();
                                if *cancel_rx.borrow() {
                                    None
                                } else {
                                    tokio::select! {
                                        resolution = resolver(payload) => resolution,
                                        _ = cancel_rx.changed() => None,
                                    }
                                }
                            }
                            (Some(resolver), None) => resolver(payload).await,
                            (None, _) => None,
                        };
                        match resolution {
                            Some(option_id) => responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                                    PermissionOptionId::from(option_id),
                                )),
                            )),
                            None => responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Cancelled,
                            )),
                        }
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(acp_agent, |connection: ConnectionTo<Agent>| async move {
                let response = connection
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;
                logger::info(&format!(
                    "ACP agent capabilities: {:?}",
                    response.agent_capabilities
                ));
                runtime.connection_ready(generation, connection).await;
                future::pending::<Result<(), agent_client_protocol::Error>>().await
            })
            .await
            .context("ACP agent connection failed")
    }

    async fn connection_ready(&self, generation: u64, connection: ConnectionTo<Agent>) {
        let waiters = {
            let mut state = self.state.lock().await;
            if state.generation != generation {
                return;
            }
            state.connection = Some(connection.clone());
            std::mem::take(&mut state.waiters)
        };
        for waiter in waiters {
            let _ = waiter.send(Ok(connection.clone()));
        }
    }

    async fn connection_stopped(&self, generation: u64, error: String) {
        let waiters = {
            let mut state = self.state.lock().await;
            if state.generation != generation {
                return;
            }
            state.connection = None;
            state.connecting = false;
            std::mem::take(&mut state.waiters)
        };
        for waiter in waiters {
            let _ = waiter.send(Err(error.clone()));
        }
        let _ = self.disconnects.send(generation);
    }

    async fn start_session(
        &self,
        cwd: PathBuf,
        load: Option<SessionId>,
        system_prompt: Option<String>,
    ) -> Result<(
        ActiveSession<'static, Agent>,
        SessionReady,
        watch::Sender<bool>,
        watch::Receiver<u64>,
        u64,
    )> {
        let connection = self.connection().await?;
        let generation = self.state.lock().await.generation;
        let (session, ready): (ActiveSession<'static, Agent>, SessionReady) = match load {
            Some(session_id) => {
                let mut request = LoadSessionRequest::new(session_id.clone(), cwd);
                if let Some(system_prompt) = &system_prompt {
                    request = request.meta(system_prompt_meta(system_prompt));
                }
                let response = connection
                    .send_request_to(Agent, request)
                    .block_task()
                    .await?;
                let (title, updated_at) = session_metadata_from_meta(response.meta.as_ref());
                let ready = SessionReady {
                    session_id: session_id.to_string(),
                    title,
                    updated_at,
                    modes: response.modes.as_ref().map(to_json),
                    config_options: response.config_options.as_ref().map(to_json),
                };
                let session = connection
                    .attach_session(NewSessionResponse::new(session_id), Default::default())?;
                (session, ready)
            }
            None => {
                let mut request = NewSessionRequest::new(cwd);
                if let Some(system_prompt) = &system_prompt {
                    request = request.meta(system_prompt_meta(system_prompt));
                }
                let response = connection
                    .send_request_to(Agent, request)
                    .block_task()
                    .await?;
                let (title, updated_at) = session_metadata_from_meta(response.meta.as_ref());
                let ready = SessionReady {
                    session_id: response.session_id.to_string(),
                    title,
                    updated_at,
                    modes: response.modes.as_ref().map(to_json),
                    config_options: response.config_options.as_ref().map(to_json),
                };
                let session = connection.attach_session(response, Default::default())?;
                (session, ready)
            }
        };
        let (cancel, _) = watch::channel(false);
        let mut permission_cancels = self.permission_cancels.lock().await;
        if permission_cancels.contains_key(&ready.session_id) {
            anyhow::bail!("ACP agent session is already active: {}", ready.session_id);
        }
        permission_cancels.insert(ready.session_id.clone(), cancel.clone());
        Ok((
            session,
            ready,
            cancel,
            self.disconnects.subscribe(),
            generation,
        ))
    }

    async fn set_session_resolver(&self, session_id: &str, resolver: PermissionResolver) {
        self.session_resolvers
            .lock()
            .await
            .insert(session_id.to_string(), resolver);
    }

    async fn clear_session_resolver(&self, session_id: &str) {
        self.session_resolvers.lock().await.remove(session_id);
    }

    async fn unregister_session(&self, session_id: &str) {
        self.permission_cancels.lock().await.remove(session_id);
        self.session_resolvers.lock().await.remove(session_id);
    }
}

fn session_metadata_from_meta(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> (Option<String>, Option<String>) {
    let string = |key| {
        meta.and_then(|meta| meta.get(key))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    (string("title"), string("updatedAt"))
}

fn system_prompt_meta(prompt: &str) -> serde_json::Map<String, serde_json::Value> {
    serde_json::Map::from_iter([(
        "systemPrompt".to_string(),
        serde_json::json!({ "append": prompt }),
    )])
}

/// Extra content sent along with a prompt.
pub enum Attachment {
    /// Plain text, e.g. the contents of an attached text file.
    Text { text: String },
    /// Base64-encoded image (`data` without the data URL prefix).
    Image { data: String, mime_type: String },
    /// Resource the agent reads itself, e.g. a `file://` path on the host.
    Resource {
        uri: String,
        name: String,
        mime_type: Option<String>,
    },
}

impl Attachment {
    fn into_content_block(self) -> ContentBlock {
        match self {
            Attachment::Text { text } => ContentBlock::Text(TextContent::new(text)),
            Attachment::Image { data, mime_type } => {
                ContentBlock::Image(ImageContent::new(data, mime_type))
            }
            Attachment::Resource {
                uri,
                name,
                mime_type,
            } => {
                let mut link = ResourceLink::new(name, uri);
                if let Some(mime_type) = mime_type {
                    link = link.mime_type(mime_type);
                }
                ContentBlock::ResourceLink(link)
            }
        }
    }
}

/// Stream events forwarded to the extension. `update` is the raw ACP session
/// update payload (text chunks included); `stop` terminates the prompt.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum AgentEvent {
    SessionUpdate { update: serde_json::Value },
    Stop { stop_reason: serde_json::Value },
}

pub type SessionEndCallback = Arc<dyn Fn(&str, &str) + Send + Sync>;

#[derive(Clone)]
pub struct AgentSessionManager {
    sessions: Arc<Mutex<HashMap<AgentSessionKey, AgentSession>>>,
    runtimes: Arc<HashMap<String, AcpRuntime>>,
    on_end: Option<SessionEndCallback>,
}

#[derive(Clone)]
struct AgentSession {
    tx: mpsc::Sender<SessionCommand>,
    busy: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct AgentSessionKey {
    agent: String,
    session_id: String,
}

impl AgentSessionKey {
    fn new(agent: &str, session_id: &str) -> Self {
        Self {
            agent: agent.to_string(),
            session_id: session_id.to_string(),
        }
    }
}

struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

enum SessionCommand {
    Prompt {
        prompt: String,
        attachments: Vec<Attachment>,
        event_tx: Option<mpsc::UnboundedSender<AgentEvent>>,
        permission_resolver: Option<PermissionResolver>,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Cancel,
    SetMode {
        mode_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetConfig {
        config_id: String,
        value: String,
        reply: oneshot::Sender<Result<serde_json::Value, String>>,
    },
    Close,
}

impl AgentSessionManager {
    pub fn new(on_end: Option<SessionEndCallback>) -> Self {
        let runtimes = agent_candidates()
            .into_iter()
            .map(|candidate| {
                let agent = candidate.id.to_string();
                (agent.clone(), AcpRuntime::new(candidate))
            })
            .collect();

        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            runtimes: Arc::new(runtimes),
            on_end,
        }
    }

    fn runtime(&self, agent: &str) -> Result<AcpRuntime> {
        self.runtimes
            .get(agent)
            .cloned()
            .with_context(|| format!("Unknown ACP agent: {agent}"))
    }

    pub async fn create_session(
        &self,
        agent: &str,
        cwd: Option<PathBuf>,
        system_prompt: Option<String>,
    ) -> Result<SessionReady> {
        self.start_session(agent, cwd, None, system_prompt, None)
            .await
    }

    /// Resume a persisted session by its ACP session id (requires the agent to
    /// support `session/load`). Returns a fresh live handle to it. With
    /// `replay_tx`, the history updates the agent replays on load are streamed
    /// there before the session reports ready.
    pub async fn load_session(
        &self,
        agent: &str,
        session_id: &str,
        cwd: Option<PathBuf>,
        system_prompt: Option<String>,
        replay_tx: Option<mpsc::UnboundedSender<AgentEvent>>,
    ) -> Result<SessionReady> {
        self.start_session(
            agent,
            cwd,
            Some(SessionId::from(session_id.to_string())),
            system_prompt,
            replay_tx,
        )
        .await
    }

    async fn start_session(
        &self,
        agent: &str,
        cwd: Option<PathBuf>,
        load: Option<SessionId>,
        system_prompt: Option<String>,
        replay_tx: Option<mpsc::UnboundedSender<AgentEvent>>,
    ) -> Result<SessionReady> {
        let cwd = resolve_cwd(cwd)?;
        let (tx, rx) = mpsc::channel(8);
        let (ready_tx, ready_rx) = oneshot::channel();
        let (ended_tx, ended_rx) = oneshot::channel::<()>();
        let runtime = self.runtime(agent)?;
        let agent = agent.to_string();
        tokio::spawn(async move {
            // ended_tx drops when the actor exits, triggering cleanup.
            let _ended_tx = ended_tx;
            if let Err(err) =
                run_session_actor_inner(cwd, load, system_prompt, runtime, replay_tx, rx, ready_tx)
                    .await
            {
                logger::info(&format!("ACP session actor stopped: {err}"));
            }
        });

        // Readiness is bounded by the caller's timeout, not here. The
        // session id is assigned by the agent.
        match ready_rx.await {
            Ok(Ok(ready)) => {
                let session_id = ready.session_id.clone();
                let session_key = AgentSessionKey::new(&agent, &session_id);
                {
                    let mut sessions = self.sessions.lock().await;
                    if sessions.contains_key(&session_key) {
                        // Dropping tx ends the duplicate actor.
                        anyhow::bail!("{agent} ACP session is already active: {session_id}");
                    }
                    sessions.insert(
                        session_key.clone(),
                        AgentSession {
                            tx,
                            busy: Arc::new(AtomicBool::new(false)),
                        },
                    );
                }
                let sessions = self.sessions.clone();
                let on_end = self.on_end.clone();
                let ended_session_key = session_key;
                tokio::spawn(async move {
                    let _ = ended_rx.await;
                    // Only report sessions that were actually registered
                    // (actors that died before readiness never were).
                    if sessions.lock().await.remove(&ended_session_key).is_some() {
                        if let Some(on_end) = on_end {
                            on_end(&ended_session_key.agent, &ended_session_key.session_id);
                        }
                    }
                });
                Ok(ready)
            }
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP agent session stopped before it was ready"),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn prompt(
        &self,
        agent: &str,
        session_id: &str,
        prompt: String,
        attachments: Vec<Attachment>,
        timeout_secs: u64,
        event_tx: Option<mpsc::UnboundedSender<AgentEvent>>,
        permission_resolver: Option<PermissionResolver>,
    ) -> Result<String> {
        let session = self.session(agent, session_id).await?;
        if session.busy.swap(true, Ordering::AcqRel) {
            anyhow::bail!("ACP agent session already has a prompt in progress");
        }
        let _busy = BusyGuard(session.busy.clone());

        // Streamed turns carry their events through a pump that renews an idle
        // deadline on every frame, so only a silent agent times out; a long but
        // productive turn never does. Without events the deadline never renews
        // and the same wait caps the whole call.
        let (turn_event_tx, last_activity) = match event_tx {
            Some(tx) => {
                let (turn_tx, mut turn_rx) = mpsc::unbounded_channel::<AgentEvent>();
                let last_activity = Arc::new(std::sync::Mutex::new(tokio::time::Instant::now()));
                let pump_activity = last_activity.clone();
                tokio::spawn(async move {
                    while let Some(event) = turn_rx.recv().await {
                        *pump_activity.lock().expect("activity lock poisoned") =
                            tokio::time::Instant::now();
                        let _ = tx.send(event);
                    }
                });
                (Some(turn_tx), Some(last_activity))
            }
            None => (None, None),
        };

        let (reply_tx, mut reply_rx) = oneshot::channel();
        let streamed = turn_event_tx.is_some();
        session
            .tx
            .send(SessionCommand::Prompt {
                prompt,
                attachments,
                event_tx: turn_event_tx,
                permission_resolver,
                reply: reply_tx,
            })
            .await
            .context("ACP agent session is closed")?;

        let timeout = std::time::Duration::from_secs(timeout_secs);
        loop {
            let started_at = last_activity
                .as_deref()
                .map(|activity| *activity.lock().expect("activity lock poisoned"))
                .unwrap_or_else(tokio::time::Instant::now);
            tokio::select! {
                reply = &mut reply_rx => {
                    return match reply {
                        Ok(Ok(answer)) => Ok(answer),
                        Ok(Err(err)) => anyhow::bail!(err),
                        Err(_) => anyhow::bail!("ACP agent session closed before responding"),
                    };
                }
                _ = tokio::time::sleep_until(started_at + timeout) => {
                    // An event may have renewed the deadline while this sleep
                    // was firing; only give up when the turn really went quiet.
                    let still_idle = last_activity
                        .as_deref()
                        .map(|activity| {
                            activity.lock().expect("activity lock poisoned").elapsed() >= timeout
                        })
                        .unwrap_or(true);
                    if !still_idle {
                        continue;
                    }
                    // Callers must keep at most one prompt in flight per session
                    // (the panel enforces this), so a timeout means the caller
                    // abandoned its turn: cancel it so the session becomes usable
                    // again instead of finishing unobserved.
                    let _ = session.tx.send(SessionCommand::Cancel).await;
                    if streamed {
                        anyhow::bail!(
                            "Timeout waiting for ACP agent: no activity for {timeout_secs}s"
                        );
                    } else {
                        anyhow::bail!("Timeout waiting for ACP agent");
                    }
                }
            }
        }
    }

    /// Cancel the in-flight prompt of a session. The prompt settles with the
    /// partial answer and a `stop` event carrying the cancel reason.
    pub async fn cancel(&self, agent: &str, session_id: &str) -> bool {
        let key = AgentSessionKey::new(agent, session_id);
        let Some(session) = self.sessions.lock().await.get(&key).cloned() else {
            return false;
        };
        session.tx.send(SessionCommand::Cancel).await.is_ok()
    }

    /// Switch the session mode (`session/set_mode`), e.g. plan mode.
    pub async fn set_mode(&self, agent: &str, session_id: &str, mode_id: &str) -> Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_command(
            agent,
            session_id,
            SessionCommand::SetMode {
                mode_id: mode_id.to_string(),
                reply: reply_tx,
            },
        )
        .await?;
        match reply_rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP agent session closed before responding"),
        }
    }

    /// Set a session config option (`session/set_config_option`). Returns the
    /// refreshed config options reported by the agent.
    pub async fn set_config_option(
        &self,
        agent: &str,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<serde_json::Value> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_command(
            agent,
            session_id,
            SessionCommand::SetConfig {
                config_id: config_id.to_string(),
                value: value.to_string(),
                reply: reply_tx,
            },
        )
        .await?;
        match reply_rx.await {
            Ok(Ok(config_options)) => Ok(config_options),
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP agent session closed before responding"),
        }
    }

    async fn session(&self, agent: &str, session_id: &str) -> Result<AgentSession> {
        let key = AgentSessionKey::new(agent, session_id);
        self.sessions
            .lock()
            .await
            .get(&key)
            .cloned()
            .with_context(|| format!("Unknown {agent} ACP session: {session_id}"))
    }

    async fn send_command(
        &self,
        agent: &str,
        session_id: &str,
        command: SessionCommand,
    ) -> Result<()> {
        let session = self.session(agent, session_id).await?;
        session
            .tx
            .send(command)
            .await
            .context("ACP agent session is closed")
    }

    pub async fn close_session(&self, agent: &str, session_id: &str) -> bool {
        let key = AgentSessionKey::new(agent, session_id);
        let Some(session) = self.sessions.lock().await.remove(&key) else {
            return false;
        };
        let _ = session.tx.send(SessionCommand::Close).await;
        true
    }

    /// List sessions persisted by an ACP agent (`session/list`). This does not
    /// create live actors, so remote clients can discover a session first and
    /// explicitly load it afterwards.
    pub async fn list_sessions(
        &self,
        agent: &str,
        cwd: Option<PathBuf>,
        cursor: Option<String>,
    ) -> Result<serde_json::Value> {
        let connection = self.runtime(agent)?.connection().await?;
        let mut request = ListSessionsRequest::new();
        if let Some(cwd) = cwd {
            request = request.cwd(cwd);
        }
        if let Some(cursor) = cursor {
            request = request.cursor(cursor);
        }
        let response = connection
            .send_request_to(Agent, request)
            .block_task()
            .await?;
        Ok(to_json(response))
    }

    pub async fn delete_session(&self, agent: &str, session_id: &str) -> Result<()> {
        let connection = self.runtime(agent)?.connection().await?;
        connection
            .send_request_to(
                Agent,
                DeleteSessionRequest::new(SessionId::from(session_id.to_string())),
            )
            .block_task()
            .await?;
        Ok(())
    }
}

async fn run_session_actor_inner(
    cwd: PathBuf,
    load: Option<SessionId>,
    system_prompt: Option<String>,
    runtime: AcpRuntime,
    replay_tx: Option<mpsc::UnboundedSender<AgentEvent>>,
    mut rx: mpsc::Receiver<SessionCommand>,
    ready_tx: oneshot::Sender<Result<SessionReady, String>>,
) -> Result<()> {
    let (mut session, mut ready, cancel_flag, mut disconnects, connection_generation) =
        match runtime.start_session(cwd, load, system_prompt).await {
            Ok(session) => session,
            Err(err) => {
                let _ = ready_tx.send(Err(err.to_string()));
                return Err(err);
            }
        };
    let session_id = ready.session_id.clone();
    let result: Result<(), agent_client_protocol::Error> = async {
        // The load-time history replay is queued before attach; forward it
        // before reporting ready so the client sees the events before the
        // load call resolves.
        if let Some(replay_tx) = &replay_tx {
            let metadata = drain_replay(&mut session, replay_tx).await?;
            ready.title = metadata.title.or(ready.title);
            ready.updated_at = metadata.updated_at.or(ready.updated_at);
        }
        let _ = ready_tx.send(Ok(ready));
        // Commands arriving while a prompt turn runs are deferred here and
        // processed after the turn settles — except config/mode changes, which
        // `run_prompt_turn` applies to the live query immediately.
        let mut deferred: VecDeque<SessionCommand> = VecDeque::new();
        loop {
            let command = match deferred.pop_front() {
                Some(command) => Some(command),
                None => tokio::select! {
                    command = rx.recv() => command,
                    changed = disconnects.changed() => {
                        if changed.is_err() || *disconnects.borrow() >= connection_generation {
                            None
                        } else {
                            continue;
                        }
                    }
                },
            };
            let Some(command) = command else { break };
            match command {
                SessionCommand::Prompt {
                    prompt,
                    attachments,
                    event_tx,
                    permission_resolver,
                    reply,
                } => {
                    if let Some(resolver) = permission_resolver {
                        runtime.set_session_resolver(&session_id, resolver).await;
                    }
                    let turn_result = run_prompt_turn(
                        &mut session,
                        prompt,
                        attachments,
                        event_tx,
                        &cancel_flag,
                        Some(&mut rx),
                    )
                    .await;
                    runtime.clear_session_resolver(&session_id).await;
                    match turn_result {
                        Ok((answer, new_deferred)) => {
                            let _ = reply.send(Ok(answer));
                            deferred.extend(new_deferred);
                        }
                        Err(err) => {
                            let _ = reply.send(Err(err.to_string()));
                        }
                    }
                }
                SessionCommand::Cancel => {
                    // No prompt running, nothing to cancel.
                }
                SessionCommand::SetMode { mode_id, reply } => {
                    send_set_mode(&session, mode_id, reply).await;
                }
                SessionCommand::SetConfig {
                    config_id,
                    value,
                    reply,
                } => {
                    send_set_config_option(&session, config_id, value, reply).await;
                }
                SessionCommand::Close => {
                    close_session_gracefully(&session).await;
                    break;
                }
            }
        }
        Ok(())
    }
    .await;
    runtime.unregister_session(&session_id).await;

    if let Err(err) = result {
        anyhow::bail!("ACP agent session failed: {err}");
    }

    Ok(())
}

fn cancel_prompt(session: &ActiveSession<'_, Agent>, cancel_flag: &watch::Sender<bool>) {
    // Pending permission requests of this turn must settle cancelled.
    let _ = cancel_flag.send(true);
    let notification = CancelNotification::new(session.session_id().clone());
    if let Err(err) = session.connection().send_notification(notification) {
        logger::info(&format!("Failed to cancel ACP session: {err}"));
    }
}

/// Ask the agent to close the session properly (e.g. persist its state)
/// before the connection drops.
async fn close_session_gracefully(session: &ActiveSession<'_, Agent>) {
    let request = CloseSessionRequest::new(session.session_id().clone());
    if let Err(err) = session
        .connection()
        .send_request_to(Agent, request)
        .block_task()
        .await
    {
        logger::info(&format!("Failed to close ACP session gracefully: {err}"));
    }
}

/// Forward the session updates queued before the session attached (the
/// `session/load` history replay) to `event_tx`. The replay is complete by the
/// time the load response arrives, so once the queue is quiet for a moment the
/// drain is done; dropping the pending `read_update` on timeout loses nothing.
#[derive(Default)]
struct SessionReplayMetadata {
    title: Option<String>,
    updated_at: Option<String>,
}

impl SessionReplayMetadata {
    fn apply(&mut self, update: &serde_json::Value) {
        if update
            .get("sessionUpdate")
            .and_then(serde_json::Value::as_str)
            != Some("session_info_update")
        {
            return;
        }
        if let Some(title) = update
            .get("title")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.title = Some(title.to_string());
        }
        if let Some(updated_at) = update
            .get("updatedAt")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.updated_at = Some(updated_at.to_string());
        }
    }
}

async fn drain_replay(
    session: &mut ActiveSession<'_, Agent>,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<SessionReplayMetadata, agent_client_protocol::Error> {
    const REPLAY_IDLE: std::time::Duration = std::time::Duration::from_millis(200);
    let mut metadata = SessionReplayMetadata::default();
    loop {
        match tokio::time::timeout(REPLAY_IDLE, session.read_update()).await {
            Ok(Ok(SessionMessage::SessionMessage(dispatch))) => {
                MatchDispatch::new(dispatch)
                    .if_notification(async |notif: SessionNotification| {
                        let update = to_json(notif.update);
                        metadata.apply(&update);
                        send_agent_event(Some(event_tx), AgentEvent::SessionUpdate { update });
                        Ok(())
                    })
                    .await
                    .otherwise_ignore()?;
            }
            Ok(Ok(_)) => {}
            Ok(Err(err)) => return Err(err),
            Err(_) => break,
        }
    }
    Ok(metadata)
}

/// Send `session/set_mode` to the live session and settle the caller's reply.
/// Safe mid-turn: claude-agent-acp applies it to the running query
/// (`setPermissionMode`), so the in-flight turn switches immediately.
async fn send_set_mode(
    session: &ActiveSession<'_, Agent>,
    mode_id: String,
    reply: oneshot::Sender<Result<(), String>>,
) {
    let request =
        SetSessionModeRequest::new(session.session_id().clone(), SessionModeId::from(mode_id));
    let result = session
        .connection()
        .send_request_to(Agent, request)
        .block_task()
        .await
        .map(|_| ())
        .map_err(|err| err.to_string());
    let _ = reply.send(result);
}

/// Send `session/set_config_option` to the live session; see `send_set_mode`
/// for why this is safe mid-turn.
async fn send_set_config_option(
    session: &ActiveSession<'_, Agent>,
    config_id: String,
    value: String,
    reply: oneshot::Sender<Result<serde_json::Value, String>>,
) {
    let request = SetSessionConfigOptionRequest::new(
        session.session_id().clone(),
        SessionConfigId::from(config_id),
        SessionConfigValueId::from(value),
    );
    let result = session
        .connection()
        .send_request_to(Agent, request)
        .block_task()
        .await
        .map(to_json)
        .map_err(|err| err.to_string());
    let _ = reply.send(result);
}

/// Run one prompt turn. While the turn runs, keeps draining `incoming` (when
/// given) so Cancel and Close stay actionable instead of queueing behind the
/// turn; config/mode changes go out live (see `send_set_mode`), other commands
/// are returned deferred.
async fn run_prompt_turn(
    session: &mut ActiveSession<'_, Agent>,
    prompt: String,
    attachments: Vec<Attachment>,
    event_tx: Option<mpsc::UnboundedSender<AgentEvent>>,
    cancel_flag: &watch::Sender<bool>,
    mut incoming: Option<&mut mpsc::Receiver<SessionCommand>>,
) -> Result<(String, Vec<SessionCommand>), agent_client_protocol::Error> {
    // New turn: clear any previous cancellation before requests can arrive.
    let _ = cancel_flag.send(false);

    // `send_prompt` only takes text, so build the request manually to support
    // image/resource blocks. The final stop reason then arrives as the
    // request response instead of through the update stream. An empty prompt
    // is fine as long as attachments carry the content (callers validate).
    let mut content: Vec<ContentBlock> = Vec::new();
    if !prompt.is_empty() {
        content.push(ContentBlock::Text(TextContent::new(prompt)));
    }
    content.extend(attachments.into_iter().map(Attachment::into_content_block));
    let stop = session
        .connection()
        .send_request_to(
            Agent,
            PromptRequest::new(session.session_id().clone(), content),
        )
        .block_task();
    tokio::pin!(stop);

    let mut answer = String::new();
    let mut deferred = Vec::new();
    loop {
        enum TurnInput {
            Update(Result<SessionMessage, agent_client_protocol::Error>),
            Stop(Result<PromptResponse, agent_client_protocol::Error>),
            Command(SessionCommand),
        }
        let input = match incoming.as_deref_mut() {
            Some(incoming) => tokio::select! {
                update = session.read_update() => TurnInput::Update(update),
                stop_result = &mut stop => TurnInput::Stop(stop_result),
                command = incoming.recv() => match command {
                    Some(command) => TurnInput::Command(command),
                    // The session is being dropped mid-turn.
                    None => break,
                },
            },
            None => tokio::select! {
                update = session.read_update() => TurnInput::Update(update),
                stop_result = &mut stop => TurnInput::Stop(stop_result),
            },
        };
        match input {
            TurnInput::Update(update) => {
                if let SessionMessage::SessionMessage(dispatch) = update? {
                    MatchDispatch::new(dispatch)
                        .if_notification(async |notif: SessionNotification| {
                            handle_session_update(notif.update, &mut answer, event_tx.as_ref())?;
                            Ok(())
                        })
                        .await
                        .otherwise_ignore()?;
                }
            }
            TurnInput::Stop(stop_result) => {
                let response = stop_result?;
                send_agent_event(
                    event_tx.as_ref(),
                    AgentEvent::Stop {
                        stop_reason: to_json(response.stop_reason),
                    },
                );
                break;
            }
            TurnInput::Command(SessionCommand::Cancel) => {
                cancel_prompt(session, cancel_flag);
            }
            TurnInput::Command(SessionCommand::Close) => {
                cancel_prompt(session, cancel_flag);
                deferred.push(SessionCommand::Close);
            }
            TurnInput::Command(SessionCommand::SetMode { mode_id, reply }) => {
                send_set_mode(session, mode_id, reply).await;
            }
            TurnInput::Command(SessionCommand::SetConfig {
                config_id,
                value,
                reply,
            }) => {
                send_set_config_option(session, config_id, value, reply).await;
            }
            TurnInput::Command(command) => deferred.push(command),
        }
    }
    Ok((answer, deferred))
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

#[cfg(test)]
mod tests {
    use super::{SessionReplayMetadata, session_metadata_from_meta};

    #[test]
    fn reads_session_metadata_from_load_meta_and_replay() {
        let meta = serde_json::Map::from_iter([
            ("title".to_string(), serde_json::json!("Loaded title")),
            (
                "updatedAt".to_string(),
                serde_json::json!("2026-08-27T00:00:00Z"),
            ),
        ]);
        assert_eq!(
            session_metadata_from_meta(Some(&meta)),
            (
                Some("Loaded title".to_string()),
                Some("2026-08-27T00:00:00Z".to_string())
            )
        );

        let mut replay = SessionReplayMetadata::default();
        replay.apply(&serde_json::json!({
            "sessionUpdate": "session_info_update",
            "title": "Replay title",
            "updatedAt": "2026-08-27T01:00:00Z"
        }));
        assert_eq!(replay.title.as_deref(), Some("Replay title"));
        assert_eq!(replay.updated_at.as_deref(), Some("2026-08-27T01:00:00Z"));
    }
}
