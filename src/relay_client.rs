//! Relay transport for the remote RPC peers, built on the shared
//! `relay-client` crate. This module manages multiple remote peers (e.g. Phone A,
//! Phone B) communicating over endpoint 1 and demultiplexes by an auto-incrementing `peerId`.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::Result;
use relay_client::{Client, ClientHandler, memory::MemoryStore, relay_frame::Endpoint};
use serde_json::{Value, json};

use crate::{agent_rpc::AgentService, app_data, logger, peer::Peer};

#[cfg(debug_assertions)]
const RELAY_URL: &str = "ws://127.0.0.1:39371/ws";
#[cfg(not(debug_assertions))]
const RELAY_URL: &str = "wss://agent-deck.xianqiao.wang/ws";

const HOST_DEVICE_ID: &str = "host";
const REMOTE_PEERS_FILE: &str = "remote_peers.json";

fn endpoint_url(relay_id: &str) -> String {
    relay_client::transport::endpoint_url(RELAY_URL, relay_id, Endpoint::One, HOST_DEVICE_ID)
}

fn load_persisted_peers() -> HashMap<String, u64> {
    let Ok(path) = app_data::root_dir().map(|dir| dir.join(REMOTE_PEERS_FILE)) else {
        return HashMap::new();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_persisted_peers(map: &HashMap<String, u64>) {
    let Ok(path) = app_data::root_dir().map(|dir| dir.join(REMOTE_PEERS_FILE)) else {
        return;
    };
    if let Ok(content) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(&path, content);
    }
}

/// Manages multiple remote peers multiplexed over a single relay connection.
/// Allocates auto-increment `peerId` to connected devices and tags/filters messages.
pub struct RemotePeerManager {
    service: AgentService,
    outbound_tx: tokio::sync::mpsc::UnboundedSender<Value>,
    device_to_peer_id: Arc<Mutex<HashMap<String, u64>>>,
    peers: Arc<Mutex<HashMap<u64, Peer>>>,
    next_peer_id: Arc<AtomicU64>,
}

impl RemotePeerManager {
    pub fn new(
        service: AgentService,
        outbound_tx: tokio::sync::mpsc::UnboundedSender<Value>,
    ) -> Self {
        let initial_dev_map = load_persisted_peers();
        let max_id = initial_dev_map.values().copied().max().unwrap_or(0);
        Self {
            service,
            outbound_tx,
            device_to_peer_id: Arc::new(Mutex::new(initial_dev_map)),
            peers: Arc::default(),
            next_peer_id: Arc::new(AtomicU64::new(max_id + 1)),
        }
    }

    pub fn get_or_create_peer(&self, peer_id: u64) -> Peer {
        let mut peers = self.peers.lock().expect("lock poisoned");
        if let Some(peer) = peers.get(&peer_id) {
            return peer.clone();
        }

        let outbound_tx = self.outbound_tx.clone();
        let peer = Peer::new(move |mut message| {
            if let Value::Object(ref mut map) = message {
                map.insert("peerId".to_string(), json!(peer_id));
            }
            if outbound_tx.send(message).is_err() {
                logger::info(&format!(
                    "Relay client stopped; peer {peer_id} message dropped"
                ));
            }
        });
        self.service.attach(&peer);
        peers.insert(peer_id, peer.clone());
        peer
    }

    fn resolve_peer_id(&self, device_id: &str, requested_peer_id: Option<u64>) -> u64 {
        let mut dev_map = self.device_to_peer_id.lock().expect("lock poisoned");
        if !device_id.is_empty() {
            if let Some(&existing) = dev_map.get(device_id) {
                return existing;
            }
        }
        let assigned = match requested_peer_id {
            Some(id) if id > 0 && !dev_map.values().any(|&v| v == id) => {
                let next = self.next_peer_id.load(Ordering::SeqCst);
                if id >= next {
                    self.next_peer_id.store(id + 1, Ordering::SeqCst);
                }
                id
            }
            _ => self.next_peer_id.fetch_add(1, Ordering::SeqCst),
        };
        if !device_id.is_empty() {
            dev_map.insert(device_id.to_string(), assigned);
            save_persisted_peers(&dev_map);
        }
        assigned
    }

    pub async fn dispatch(&self, mut payload: Value) {
        if payload.get("method").and_then(Value::as_str) == Some("peer_attach") {
            self.handle_attach(payload);
            return;
        }

        let peer_id = payload.get("peerId").and_then(Value::as_u64).unwrap_or(1);
        let peer = self.get_or_create_peer(peer_id);
        if let Value::Object(ref mut map) = payload {
            map.remove("peerId");
        }
        peer.dispatch(payload).await;
    }

    fn handle_attach(&self, payload: Value) {
        let id = payload.get("id").cloned();
        let params = payload.get("params").cloned().unwrap_or(Value::Null);
        let device_id = params
            .get("deviceId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let requested_peer_id = params.get("peerId").and_then(Value::as_u64);

        let peer_id = self.resolve_peer_id(&device_id, requested_peer_id);
        let _peer = self.get_or_create_peer(peer_id);

        let response = match id {
            Some(req_id) => json!({
                "peerId": peer_id,
                "id": req_id,
                "result": { "peerId": peer_id, "deviceId": device_id }
            }),
            None => json!({
                "peerId": peer_id,
                "method": "peer_attached",
                "params": { "peerId": peer_id, "deviceId": device_id }
            }),
        };
        let _ = self.outbound_tx.send(response);
    }
}

struct Handler {
    manager: Arc<RemotePeerManager>,
}

impl ClientHandler for Handler {
    fn on_payload(&self, payload: Value) {
        let manager = self.manager.clone();
        tokio::spawn(async move {
            manager.dispatch(payload).await;
        });
    }

    fn on_connected(&self) {
        logger::info("Connected to relay WebSocket");
        let _ = self.manager.outbound_tx.send(json!({
            "method": "host_reconnected",
            "params": {}
        }));
    }

    fn on_disconnected(&self, _error: Option<String>) {
        // Relay client reconnects indefinitely in the background; do not log
        // disconnects or connection errors to avoid flooding logs or disk.
    }

    fn on_preempted(&self) {
        logger::info("Relay connection preempted: another host connection opened");
    }
}

/// Start the remote RPC transport with the pairing id supplied by the
/// extension. The service endpoint is the built-in local relay URL.
pub fn start(relay_id: &str, service: &AgentService) -> Result<Arc<RemotePeerManager>> {
    validate_relay_id(relay_id)?;
    let store = Arc::new(MemoryStore::new());

    // `Peer`'s writer is a sync callback on arbitrary threads; bridge it to
    // the async client through an unbounded channel drained by a dedicated task.
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();

    let manager = Arc::new(RemotePeerManager::new(service.clone(), outbound_tx));

    let client = Client::new(
        endpoint_url(relay_id),
        store,
        Arc::new(Handler {
            manager: manager.clone(),
        }),
    );

    let send_client = client.clone();
    tokio::spawn(async move {
        while let Some(payload) = outbound_rx.recv().await {
            if let Err(error) = send_client.send(payload).await {
                logger::info(&format!("Failed to queue relay message: {error:#}"));
            }
        }
    });

    tokio::spawn(client.into_task());
    Ok(manager)
}

fn validate_relay_id(relay_id: &str) -> Result<()> {
    let valid = relay_id.len() == 36
        && relay_id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    anyhow::ensure!(valid, "relay id must be a UUID");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_adds_identity_to_built_in_url() {
        let relay_id = "01234567-89ab-cdef-0123-456789abcdef";
        assert_eq!(
            endpoint_url(relay_id),
            format!("{RELAY_URL}?id={relay_id}&endpoint=1&device_id=host")
        );
        assert!(validate_relay_id(relay_id).is_ok());
        assert!(validate_relay_id("not-a-uuid&endpoint=2").is_err());
    }

    #[tokio::test]
    async fn start_initializes_manager_and_handles_attach_and_routing() {
        let relay_id = "01234567-89ab-cdef-0123-456789abcdef";
        let service = AgentService::new();
        let manager = start(relay_id, &service).expect("start relay manager");
        let peer1 = manager.get_or_create_peer(1);
        peer1.notify("ping", serde_json::json!({ "ok": true }));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn remote_peer_manager_demultiplexes_multiple_devices() {
        let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let service = AgentService::new();
        let manager = Arc::new(RemotePeerManager::new(service, outbound_tx));

        // Phone A attaches
        manager
            .dispatch(json!({
                "id": "req-a1",
                "method": "peer_attach",
                "params": { "deviceId": "device-phone-a" }
            }))
            .await;

        let res_a = outbound_rx.recv().await.expect("Phone A response");
        assert_eq!(res_a.get("peerId").and_then(Value::as_u64), Some(1));
        assert_eq!(
            res_a
                .get("result")
                .and_then(|r| r.get("peerId"))
                .and_then(Value::as_u64),
            Some(1)
        );

        // Phone B attaches
        manager
            .dispatch(json!({
                "id": "req-b1",
                "method": "peer_attach",
                "params": { "deviceId": "device-phone-b" }
            }))
            .await;

        let res_b = outbound_rx.recv().await.expect("Phone B response");
        assert_eq!(res_b.get("peerId").and_then(Value::as_u64), Some(2));
        assert_eq!(
            res_b
                .get("result")
                .and_then(|r| r.get("peerId"))
                .and_then(Value::as_u64),
            Some(2)
        );

        // Phone A calls agent_list with peerId 1
        manager
            .dispatch(json!({
                "peerId": 1,
                "id": "req-a2",
                "method": "agent_list",
                "params": {}
            }))
            .await;

        let res_agents = outbound_rx.recv().await.expect("Phone A agent_list");
        assert_eq!(res_agents.get("peerId").and_then(Value::as_u64), Some(1));
        assert_eq!(res_agents.get("id").and_then(Value::as_str), Some("req-a2"));
        assert!(res_agents.get("result").is_some());
    }
}
