use super::*;
use agent_client_protocol::Channel;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{future, time::Duration};
use tokio::task::JoinHandle;

// The real manager, actors and ACP SDK run against an in-memory ACP transport.
// No user agent, browser or Relay process is started or stopped.
struct MockAcp {
    manager: AgentSessionManager,
    peer: Channel,
    connection: JoinHandle<()>,
}

impl MockAcp {
    async fn new() -> Self {
        let manager = AgentSessionManager::new(None);
        let (peer, connection) = Self::connect(&manager).await;
        Self {
            manager,
            peer,
            connection,
        }
    }

    async fn connect(manager: &AgentSessionManager) -> (Channel, JoinHandle<()>) {
        let runtime = manager.runtime("codex").unwrap();
        let generation = {
            let mut state = runtime.state.lock().await;
            state.generation += 1;
            state.generation
        };
        let (transport, mut peer) = Channel::duplex();
        let connected_runtime = runtime.clone();
        let connection = tokio::spawn(async move {
            let _ = connected_runtime.connect_agent(generation, transport).await;
            connected_runtime
                .connection_stopped(generation, "mock ACP disconnected".into())
                .await;
        });
        let request = to_json(peer.rx.next().await.unwrap().unwrap());
        assert_eq!(request["method"], "initialize");
        peer.tx
            .unbounded_send(Ok(serde_json::from_value(json!({
                "jsonrpc": "2.0", "id": request["id"], "result": {
                    "protocolVersion": 1, "agentCapabilities": {"loadSession": true}
                }
            }))
            .unwrap()))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.state.lock().await.connection.is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        (peer, connection)
    }

    async fn next(&mut self, method: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let message = to_json(self.peer.rx.next().await.unwrap().unwrap());
                // Dropping an in-flight SDK request emits this transport-level cancellation.
                if message["method"] == "$/cancel_request" {
                    continue;
                }
                assert_eq!(message["method"], method, "{message}");
                return message;
            }
        })
        .await
        .expect("ACP request did not arrive")
    }

    fn respond(&self, request: &Value, result: Value) {
        self.peer
            .tx
            .unbounded_send(Ok(serde_json::from_value(json!({
                "jsonrpc": "2.0", "id": request["id"], "result": result,
            }))
            .unwrap()))
            .unwrap();
    }

    async fn create(&mut self, id: &str) {
        let manager = self.manager.clone();
        let call = tokio::spawn(async move { manager.create_session("codex", None, None).await });
        let request = self.next("session/new").await;
        self.respond(&request, json!({"sessionId": id}));
        assert_eq!(call.await.unwrap().unwrap().session_id, id);
    }

    async fn load(&mut self, id: &str) {
        let manager = self.manager.clone();
        let id = id.to_string();
        let call =
            tokio::spawn(async move { manager.load_session("codex", &id, None, None, None).await });
        let request = self.next("session/load").await;
        self.respond(&request, json!({}));
        call.await.unwrap().unwrap();
    }

    fn close(&self, id: &str) -> JoinHandle<bool> {
        let manager = self.manager.clone();
        let id = id.to_string();
        tokio::spawn(async move { manager.close_session("codex", &id).await })
    }

    fn prompt(&self, id: &str) -> JoinHandle<Result<String>> {
        let manager = self.manager.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            manager
                .prompt("codex", &id, "test".into(), vec![], 30, None, None)
                .await
        })
    }
}

impl Drop for MockAcp {
    fn drop(&mut self) {
        self.connection.abort();
    }
}

#[tokio::test]
async fn close_waits_for_acp_release_before_load_and_prompt() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let close = mock.close("session");
    mock.next("session/cancel").await;
    let request = mock.next("session/close").await;
    assert!(
        !close.is_finished(),
        "close returned before ACP released the session"
    );
    mock.respond(&request, json!({}));
    assert!(close.await.unwrap());
    mock.load("session").await;
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn close_timeout_releases_pending_turn_and_permissions_but_preserves_other_sessions() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    mock.create("other").await;
    let runtime = mock.manager.runtime("codex").unwrap();
    // Closing must latch cancellation even before a permission handler subscribes.
    let cancel = runtime.permission_cancels.lock().await["session"].clone();
    runtime
        .set_session_resolver("session", Arc::new(|_| Box::pin(future::pending())))
        .await;
    let prompt = mock.prompt("session");
    let old_prompt = mock.next("session/prompt").await;
    let close = mock.close("session");
    mock.next("session/cancel").await;
    let old_close = mock.next("session/close").await;
    assert!(*cancel.borrow(), "pending permission must be cancelled");
    assert!(
        tokio::time::timeout(Duration::from_secs(1), prompt)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(
        tokio::time::timeout(SESSION_CLOSE_TIMEOUT + Duration::from_secs(1), close)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        !runtime
            .permission_cancels
            .lock()
            .await
            .contains_key("session")
    );
    assert!(
        !runtime
            .session_resolvers
            .lock()
            .await
            .contains_key("session")
    );
    assert!(mock.manager.session("codex", "other").await.is_ok());
    // Replies from the abandoned turn/close must not invalidate the new actor.
    mock.load("session").await;
    mock.respond(&old_prompt, json!({"stopReason": "cancelled"}));
    mock.respond(&old_close, json!({}));
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
    assert!(mock.manager.session("codex", "session").await.is_ok());
}

#[tokio::test]
async fn concurrent_close_and_load_wait_for_one_cleanup() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let first = mock.close("session");
    mock.next("session/cancel").await;
    let close = mock.next("session/close").await;
    let second = mock.close("session");
    let manager = mock.manager.clone();
    let load = tokio::spawn(async move {
        manager
            .load_session("codex", "session", None, None, None)
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), mock.peer.rx.next())
            .await
            .is_err(),
        "load must not reach ACP before close finishes"
    );
    assert!(!first.is_finished() && !second.is_finished());
    mock.respond(&close, json!({}));
    assert!(first.await.unwrap());
    assert!(second.await.unwrap());
    let request = mock.next("session/load").await;
    mock.respond(&request, json!({}));
    load.await.unwrap().unwrap();
    assert!(mock.manager.session("codex", "session").await.is_ok());
}

#[tokio::test]
async fn close_interrupts_a_stuck_mode_request_and_unsupported_close_is_recoverable() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let manager = mock.manager.clone();
    let mode = tokio::spawn(async move { manager.set_mode("codex", "session", "plan").await });
    let old_mode = mock.next("session/set_mode").await;
    let close = mock.close("session");
    mock.next("session/cancel").await;
    let request = mock.next("session/close").await;
    mock.peer
        .tx
        .unbounded_send(Ok(serde_json::from_value(json!({
            "jsonrpc": "2.0", "id": request["id"],
            "error": {"code": -32601, "message": "Method not found"},
        }))
        .unwrap()))
        .unwrap();
    assert!(close.await.unwrap());
    assert!(mode.await.unwrap().is_err());
    mock.load("session").await;
    mock.respond(&old_mode, json!({}));
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn loading_an_active_session_is_rejected_before_contacting_acp() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let result = mock
        .manager
        .load_session("codex", "session", None, None, None)
        .await;
    assert!(result.err().unwrap().to_string().contains("already active"));
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn abandoned_load_replay_does_not_leave_an_unregistered_actor() {
    let mut mock = MockAcp::new().await;
    let manager = mock.manager.clone();
    let (replay_tx, mut replay_rx) = mpsc::unbounded_channel();
    let load = tokio::spawn(async move {
        manager
            .load_session("codex", "session", None, None, Some(replay_tx))
            .await
    });
    let request = mock.next("session/load").await;
    mock.respond(&request, json!({}));
    // Wait for attach, then supply a replay event to establish that the actor is draining history.
    let runtime = mock.manager.runtime("codex").unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !runtime
            .permission_cancels
            .lock()
            .await
            .contains_key("session")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    mock.peer.tx.unbounded_send(Ok(serde_json::from_value(json!({
        "jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": "session", "update": {
                "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "history"}
            }
        }
    })).unwrap())).unwrap();
    tokio::time::timeout(Duration::from_secs(1), replay_rx.recv())
        .await
        .unwrap()
        .unwrap();
    load.abort();
    assert!(load.await.err().unwrap().is_cancelled());
    mock.next("session/cancel").await;
    let request = mock.next("session/close").await;
    mock.respond(&request, json!({}));
    tokio::time::timeout(Duration::from_secs(1), async {
        while runtime
            .permission_cancels
            .lock()
            .await
            .contains_key("session")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    mock.load("session").await;
    assert!(mock.manager.session("codex", "session").await.is_ok());
}

#[tokio::test]
async fn acp_disconnect_cleans_old_actor_before_reconnecting_and_loading() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let old = mock.manager.session("codex", "session").await.unwrap();
    let prompt = mock.prompt("session");
    mock.next("session/prompt").await;
    mock.peer.tx.close_channel();
    tokio::time::timeout(Duration::from_secs(1), old.wait_closed())
        .await
        .unwrap();
    assert!(prompt.await.unwrap().is_err());
    assert!(!mock.manager.close_session("codex", "session").await);
    let (peer, connection) = MockAcp::connect(&mock.manager).await;
    mock.peer = peer;
    mock.connection = connection;
    mock.load("session").await;
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn close_cancels_a_real_acp_permission_request_without_waiting_for_the_user() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let (permission_tx, mut permission_rx) = mpsc::unbounded_channel();
    let resolver: PermissionResolver = Arc::new(move |request| {
        permission_tx.send(request).unwrap();
        Box::pin(future::pending())
    });
    let manager = mock.manager.clone();
    let prompt = tokio::spawn(async move {
        manager
            .prompt(
                "codex",
                "session",
                "test".into(),
                vec![],
                30,
                None,
                Some(resolver),
            )
            .await
    });
    mock.next("session/prompt").await;
    mock.peer
        .tx
        .unbounded_send(Ok(serde_json::from_value(json!({
            "jsonrpc": "2.0", "id": "permission", "method": "session/request_permission",
            "params": {
                "sessionId": "session",
                "toolCall": {"toolCallId": "tool", "title": "Test permission", "status": "pending"},
                "options": [{"optionId": "allow", "name": "Allow once", "kind": "allow_once"}]
            }
        }))
        .unwrap()))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), permission_rx.recv())
        .await
        .unwrap()
        .unwrap();
    let close = mock.close("session");
    tokio::time::timeout(Duration::from_secs(1), async {
        let (mut cancelled, mut closed, mut permission_cancelled) = (false, false, false);
        while !(cancelled && closed && permission_cancelled) {
            let message = to_json(mock.peer.rx.next().await.unwrap().unwrap());
            match message["method"].as_str() {
                Some("$/cancel_request") => {}
                Some("session/cancel") => cancelled = true,
                Some("session/close") => {
                    mock.respond(&message, json!({}));
                    closed = true;
                }
                None if message["id"] == "permission" => {
                    assert_eq!(message["result"]["outcome"]["outcome"], "cancelled");
                    permission_cancelled = true;
                }
                _ => panic!("Unexpected ACP message: {message}"),
            }
        }
    })
    .await
    .unwrap();
    assert!(close.await.unwrap());
    assert!(prompt.await.unwrap().is_err());
    mock.load("session").await;
}
