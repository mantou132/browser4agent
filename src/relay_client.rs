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
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    agent_rpc::AgentService,
    app_data, logger,
    peer::Peer,
    push,
    relay_encryption::{RelayEncryption, is_plain_id},
};

#[cfg(debug_assertions)]
const RELAY_URL: &str = "ws://127.0.0.1:39371/ws";
#[cfg(not(debug_assertions))]
const RELAY_URL: &str = "wss://agent-deck.xianqiao.wang/ws";

const HOST_DEVICE_ID: &str = "host";
const REMOTE_PEERS_FILE: &str = "remote_peers_v1.json";

fn endpoint_url(relay_id: &str) -> String {
    relay_client::transport::endpoint_url(RELAY_URL, relay_id, Endpoint::One, HOST_DEVICE_ID)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDevice {
    peer_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fcm_token: Option<String>,
}

fn load_persisted_peers() -> HashMap<String, RemoteDevice> {
    let Ok(path) = app_data::root_dir().map(|dir| dir.join(REMOTE_PEERS_FILE)) else {
        return HashMap::new();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_persisted_peers(map: &HashMap<String, RemoteDevice>) {
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
    outbound_tx: tokio::sync::mpsc::UnboundedSender<(Value, Option<String>)>,
    devices: Arc<Mutex<HashMap<String, RemoteDevice>>>,
    peers: Arc<Mutex<HashMap<u64, Peer>>>,
    next_peer_id: Arc<AtomicU64>,
    push_client: reqwest::Client,
}

impl RemotePeerManager {
    pub fn new(
        service: AgentService,
        outbound_tx: tokio::sync::mpsc::UnboundedSender<(Value, Option<String>)>,
    ) -> Self {
        let initial_dev_map = load_persisted_peers();
        let max_id = initial_dev_map
            .values()
            .map(|device| device.peer_id)
            .max()
            .unwrap_or(0);
        Self {
            service,
            outbound_tx,
            devices: Arc::new(Mutex::new(initial_dev_map)),
            peers: Arc::default(),
            next_peer_id: Arc::new(AtomicU64::new(max_id + 1)),
            push_client: reqwest::Client::new(),
        }
    }

    pub fn get_or_create_peer(&self, peer_id: u64) -> Peer {
        let mut peers = self.peers.lock().expect("lock poisoned");
        if let Some(peer) = peers.get(&peer_id) {
            return peer.clone();
        }

        let outbound_tx = self.outbound_tx.clone();
        let devices = self.devices.clone();
        let peer = Peer::new(move |mut message| {
            if let Value::Object(ref mut map) = message {
                map.insert("peerId".to_string(), json!(peer_id));
            }
            let target_device_id = devices.lock().ok().and_then(|devs| {
                devs.iter()
                    .find(|(_, d)| d.peer_id == peer_id)
                    .map(|(k, _)| k.clone())
            });
            if outbound_tx.send((message, target_device_id)).is_err() {
                logger::info(&format!(
                    "Relay client stopped; peer {peer_id} message dropped"
                ));
            }
        });
        self.service
            .attach_with_completion(&peer, Some(self.completion_handler(peer_id)));
        peers.insert(peer_id, peer.clone());
        peer
    }

    fn completion_handler(&self, peer_id: u64) -> crate::agent_rpc::PromptCompletion {
        let devices = self.devices.clone();
        let client = self.push_client.clone();
        Arc::new(move |agent, session_id| {
            let token = devices.lock().ok().and_then(|devs| {
                devs.values()
                    .find(|d| d.peer_id == peer_id)
                    .and_then(|d| d.fcm_token.clone())
            });
            let Some(token) = token else { return };
            let client = client.clone();
            let agent = agent.to_owned();
            let session_id = session_id.to_owned();
            tokio::spawn(async move {
                push::send(&client, &token, &agent, &session_id).await;
            });
        })
    }

    fn resolve_peer_id(
        &self,
        device_id: &str,
        requested_peer_id: Option<u64>,
        token: Option<&Value>,
    ) -> u64 {
        let mut dev_map = self.devices.lock().expect("lock poisoned");
        if !device_id.is_empty() {
            if let Some(existing) = dev_map.get_mut(device_id) {
                let peer_id = existing.peer_id;
                let new_token = match token {
                    Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                    Some(Value::Null) => None,
                    _ => existing.fcm_token.clone(),
                };
                if existing.fcm_token != new_token {
                    existing.fcm_token = new_token;
                    save_persisted_peers(&dev_map);
                }
                return peer_id;
            }
        }
        let assigned = match requested_peer_id {
            Some(id) if id > 0 && !dev_map.values().any(|v| v.peer_id == id) => {
                let next = self.next_peer_id.load(Ordering::SeqCst);
                if id >= next {
                    self.next_peer_id.store(id + 1, Ordering::SeqCst);
                }
                id
            }
            _ => self.next_peer_id.fetch_add(1, Ordering::SeqCst),
        };
        if !device_id.is_empty() {
            let fcm_token = match token {
                Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                _ => None,
            };
            dev_map.insert(
                device_id.to_string(),
                RemoteDevice {
                    peer_id: assigned,
                    fcm_token,
                },
            );
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

        let peer_id = self.resolve_peer_id(&device_id, requested_peer_id, params.get("fcmToken"));
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
        let target = if device_id.is_empty() {
            None
        } else {
            Some(device_id)
        };
        let _ = self.outbound_tx.send((response, target));
    }
}

struct Handler {
    manager: Arc<RemotePeerManager>,
    encryption: Option<Arc<RelayEncryption>>,
}

fn encrypt_for_relay(
    encryption: &RelayEncryption,
    message: Value,
    target_device_id: Option<&str>,
) -> Result<Value> {
    let oversized_reply = if message.get("id").is_some() && message.get("method").is_none() {
        Some(json!({
            "id": message["id"],
            "peerId": message["peerId"],
            "error": "Response is too large for encrypted Relay transport. Request a smaller file or result."
        }))
    } else {
        None
    };
    let payload = encryption.seal(message)?;
    // MemoryStore generates UUID message IDs. Count the actual Relay envelope,
    // including targeting, without copying the potentially large ciphertext.
    let empty_frame = relay_client::relay_frame::ClientFrame::Message {
        message_id: "00000000-0000-0000-0000-000000000000".into(),
        payload: Value::Null,
        target_device_id: target_device_id.map(str::to_owned),
    };
    let size = serde_json::to_vec(&empty_frame)?.len() - 4 + serde_json::to_vec(&payload)?.len();
    if size > 10 * 1024 * 1024 {
        return encryption.seal(
            oversized_reply
                .ok_or_else(|| anyhow::anyhow!("Encrypted relay message is too large"))?,
        );
    }
    Ok(payload)
}

impl ClientHandler for Handler {
    fn on_payload(&self, payload: Value) {
        let payload = if let Some(encryption) = &self.encryption {
            let decrypted = encryption.open(payload);
            match decrypted {
                Ok((sender, message)) => {
                    // Bind the RPC peer to the authenticated sender, never the outer Relay route.
                    let attached =
                        if message.get("method").and_then(Value::as_str) == Some("peer_attach") {
                            message.pointer("/params/deviceId").and_then(Value::as_str)
                                == Some(sender.as_str())
                        } else {
                            let peers = self.manager.devices.lock().expect("lock poisoned");
                            peers.get(&sender).is_some_and(|id| {
                                message.get("peerId").and_then(Value::as_u64) == Some(id.peer_id)
                            })
                        };
                    if !attached {
                        logger::info("Rejected encrypted RPC with mismatched device identity");
                        return;
                    }
                    message
                }
                Err(error) => {
                    logger::info(&format!("Rejected encrypted relay message: {error:#}"));
                    return;
                }
            }
        } else {
            payload
        };
        let manager = self.manager.clone();
        tokio::spawn(async move {
            manager.dispatch(payload).await;
        });
    }

    fn on_connected(&self) {
        logger::info("Connected to relay WebSocket");
        let _ = self.manager.outbound_tx.send((
            json!({
                "method": "host_reconnected",
                "params": {}
            }),
            None,
        ));
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
    let encryption = if is_plain_id(relay_id) {
        None
    } else {
        Some(Arc::new(RelayEncryption::new(relay_id)?))
    };
    let route_id = encryption
        .as_ref()
        .map(|codec| codec.route_id.clone())
        .unwrap_or_else(|| relay_id.to_owned());
    let store = Arc::new(MemoryStore::new());

    // `Peer`'s writer is a sync callback on arbitrary threads; bridge it to
    // the async client through an unbounded channel drained by a dedicated task.
    let (outbound_tx, mut outbound_rx) =
        tokio::sync::mpsc::unbounded_channel::<(Value, Option<String>)>();

    let manager = Arc::new(RemotePeerManager::new(service.clone(), outbound_tx));

    let client = Client::new_with_ack_head(
        endpoint_url(&route_id),
        true,
        store,
        Arc::new(Handler {
            manager: manager.clone(),
            encryption: encryption.clone(),
        }),
    );

    let send_client = client.clone();
    tokio::spawn(async move {
        while let Some((payload, target_device_id)) = outbound_rx.recv().await {
            let payload = if let Some(encryption) = &encryption {
                match encrypt_for_relay(encryption, payload, target_device_id.as_deref()) {
                    Ok(payload) => payload,
                    Err(error) => {
                        logger::info(&format!("Failed to encrypt relay message: {error:#}"));
                        continue;
                    }
                }
            } else {
                payload
            };
            if let Err(error) = send_client.send_targeted(payload, target_device_id).await {
                logger::info(&format!("Failed to queue relay message: {error:#}"));
            }
        }
    });

    tokio::spawn(client.into_task());
    Ok(manager)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn repeated_attach_updates_fcm_token() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let manager = RemotePeerManager::new(AgentService::new(), tx);
        manager
            .dispatch(json!({
                "id": "1",
                "method": "peer_attach",
                "params": { "deviceId": "phone-a", "fcmToken": "token-1" }
            }))
            .await;
        let _ = rx.recv().await.unwrap();
        assert_eq!(
            manager.devices.lock().unwrap()["phone-a"]
                .fcm_token
                .as_deref(),
            Some("token-1")
        );

        manager
            .dispatch(json!({
                "id": "2",
                "method": "peer_attach",
                "params": { "deviceId": "phone-a", "fcmToken": "token-2" }
            }))
            .await;
        let _ = rx.recv().await.unwrap();
        assert_eq!(
            manager.devices.lock().unwrap()["phone-a"]
                .fcm_token
                .as_deref(),
            Some("token-2")
        );

        manager
            .dispatch(json!({
                "id": "3",
                "method": "peer_attach",
                "params": { "deviceId": "phone-a", "fcmToken": null }
            }))
            .await;
        let _ = rx.recv().await.unwrap();
        assert!(
            manager.devices.lock().unwrap()["phone-a"]
                .fcm_token
                .is_none()
        );
    }

    #[test]
    fn encrypted_file_response_over_limit_becomes_a_small_authenticated_error() {
        let vector: Value =
            serde_json::from_str(include_str!("../test/fixtures/e2ee-v1.json")).unwrap();
        let codec = RelayEncryption::new(vector["id"].as_str().unwrap()).unwrap();
        let frame = encrypt_for_relay(
            &codec,
            json!({"id": "file-1", "peerId": 1, "result": {"text": "x".repeat(8 * 1024 * 1024)}}),
            Some("test-phone"),
        )
        .unwrap();
        assert_eq!(frame["e2ee"], 1);
        assert!(serde_json::to_vec(&frame).unwrap().len() < 1024);
        assert!(!serde_json::to_string(&frame).unwrap().contains("file-1"));
        assert!(frame.get("sequence").is_none());
    }

    #[tokio::test]
    async fn encrypted_handler_routes_authenticated_devices() {
        let vector: Value =
            serde_json::from_str(include_str!("../test/fixtures/e2ee-v1.json")).unwrap();
        let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel();
        // A known device keeps this test independent from user pairing files.
        let manager = Arc::new(RemotePeerManager {
            service: AgentService::new(),
            outbound_tx,
            devices: Arc::new(Mutex::new(HashMap::from([(
                "test-phone".into(),
                RemoteDevice {
                    peer_id: 1,
                    fcm_token: None,
                },
            )]))),
            peers: Arc::default(),
            next_peer_id: Arc::new(AtomicU64::new(2)),
            push_client: reqwest::Client::new(),
        });
        let handler = Handler {
            manager,
            encryption: Some(Arc::new(
                RelayEncryption::new(vector["id"].as_str().unwrap()).unwrap(),
            )),
        };
        handler.on_payload(vector["attachFrame"].clone());
        let (attached, target) =
            tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(attached["result"]["peerId"], 1);
        assert_eq!(target.as_deref(), Some("test-phone"));
        handler.on_payload(vector["listFrame"].clone());
        let (result, target) =
            tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(result["id"], "list-1");
        assert!(result["result"]["agents"].is_array());
        assert_eq!(target.as_deref(), Some("test-phone"));
        handler.on_payload(vector["wrongPeerFrame"].clone());
        handler.on_payload(vector["wrongDeviceFrame"].clone());
        handler.on_payload(json!({"id":"plain", "method":"agent_list", "peerId":1}));
        tokio::task::yield_now().await;
        assert!(outbound_rx.try_recv().is_err());
    }

    #[test]
    fn endpoint_url_adds_identity_to_built_in_url() {
        let relay_id = "01234567-89ab-cdef-0123-456789abcdef";
        assert_eq!(
            endpoint_url(relay_id),
            format!("{RELAY_URL}?id={relay_id}&endpoint=1&device_id=host")
        );
        assert!(is_plain_id(relay_id));
        assert!(!is_plain_id("not-a-uuid&endpoint=2"));
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
        let (outbound_tx, mut outbound_rx) =
            tokio::sync::mpsc::unbounded_channel::<(Value, Option<String>)>();
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

        let (res_a, target_a) = outbound_rx.recv().await.expect("Phone A response");
        assert_eq!(target_a, Some("device-phone-a".to_string()));
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

        let (res_b, target_b) = outbound_rx.recv().await.expect("Phone B response");
        assert_eq!(target_b, Some("device-phone-b".to_string()));
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

        let (res_agents, target_agents) = outbound_rx.recv().await.expect("Phone A agent_list");
        assert_eq!(target_agents, Some("device-phone-a".to_string()));
        assert_eq!(res_agents.get("peerId").and_then(Value::as_u64), Some(1));
        assert_eq!(res_agents.get("id").and_then(Value::as_str), Some("req-a2"));
        assert!(res_agents.get("result").is_some());
    }
}
