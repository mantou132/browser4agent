//! Relay transport for the remote RPC peer, built on the shared
//! `relay-client` crate. This module only adapts it to this host: endpoint 1,
//! the extension-supplied pairing id, and the `Peer` bridge.

use std::sync::Arc;

use anyhow::Result;
use relay_client::{
    Client, ClientHandler, ConflictPolicy, memory::MemoryStore, relay_frame::Endpoint,
};
use serde_json::Value;

use crate::{browser_agent, logger, peer::Peer};

#[cfg(debug_assertions)]
const RELAY_URL: &str = "ws://127.0.0.1:39371/ws";
#[cfg(not(debug_assertions))]
const RELAY_URL: &str = "wss://agent-deck.xianqiao.wang/ws";

fn endpoint_url(relay_id: &str) -> String {
    relay_client::transport::endpoint_url(RELAY_URL, relay_id, Endpoint::One)
}

struct Handler {
    peer: Peer,
}

impl ClientHandler for Handler {
    fn on_payload(&self, payload: Value) {
        // Inbound payloads run on the client task; dispatch requests are
        // answered asynchronously inside `dispatch` itself.
        let peer = self.peer.clone();
        tokio::spawn(async move {
            peer.dispatch(payload).await;
        });
    }

    fn on_connected(&self) {
        logger::info("Connected to relay WebSocket");
    }

    fn on_disconnected(&self, error: Option<String>) {
        match error {
            Some(error) => logger::info(&format!("Relay WebSocket error: {error}")),
            None => logger::info("Relay WebSocket disconnected"),
        }
    }

    fn on_conflict(&self) {
        logger::info("Relay connection conflict: this id and endpoint is already connected");
    }
}

/// Start the remote RPC transport with the pairing id supplied by the
/// extension. The service endpoint is the built-in local relay URL.
pub fn start(relay_id: &str) -> Result<Peer> {
    validate_relay_id(relay_id)?;
    let store = Arc::new(MemoryStore::new());

    // `Peer`'s writer is a sync callback on arbitrary threads; bridge it to
    // the async client through an unbounded channel drained by a dedicated task.
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();

    let peer = Peer::new(move |message| {
        if outbound_tx.send(message).is_err() {
            logger::info("Relay client stopped; message dropped before send");
        }
    });
    browser_agent::register(&peer);

    let client = Client::new(
        endpoint_url(relay_id),
        store,
        Arc::new(Handler { peer: peer.clone() }),
        ConflictPolicy::Terminal,
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
    Ok(peer)
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
            format!("{RELAY_URL}?id={relay_id}&endpoint=1")
        );
        assert!(validate_relay_id(relay_id).is_ok());
        assert!(validate_relay_id("not-a-uuid&endpoint=2").is_err());
    }

    #[tokio::test]
    async fn start_initializes_peer_and_enqueues_outbound_messages() {
        let relay_id = "01234567-89ab-cdef-0123-456789abcdef";
        let peer = start(relay_id).expect("start relay peer");
        peer.notify("ping", serde_json::json!({ "ok": true }));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}
