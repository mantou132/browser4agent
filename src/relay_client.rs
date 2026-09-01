use std::{
    collections::HashSet,
    process,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use relay::{ClientFrame, Endpoint, ServerFrame};
use serde_json::Value;
use tokio::sync::Notify;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::{browser_agent, logger, peer::Peer};

#[cfg(debug_assertions)]
const RELAY_URL: &str = "ws://127.0.0.1:39371/ws";
#[cfg(not(debug_assertions))]
const RELAY_URL: &str = "wss://agent-deck.xianqiao.wang/ws";
const MIN_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);

fn endpoint_url(relay_id: &str) -> String {
    format!("{RELAY_URL}?id={relay_id}&endpoint=1")
}

#[derive(Clone, Debug)]
struct OutboundMessage {
    message_id: String,
    payload: Value,
}

#[derive(Debug)]
struct ClientState {
    message_prefix: String,
    next_message: u64,
    last_received: Option<u64>,
    outbox: Vec<OutboundMessage>,
}

impl ClientState {
    fn new() -> Result<Self> {
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system clock is before the Unix epoch")?
            .as_nanos();
        Ok(Self {
            message_prefix: format!("{started_at:x}-{:x}", process::id()),
            next_message: 0,
            last_received: None,
            outbox: Vec::new(),
        })
    }
}

struct MemoryOutbox {
    state: Mutex<ClientState>,
    changed: Notify,
}

impl MemoryOutbox {
    fn new() -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            state: Mutex::new(ClientState::new()?),
            changed: Notify::new(),
        }))
    }

    fn enqueue(&self, payload: &Value) {
        let result = (|| -> Result<()> {
            let mut state = self.state.lock().expect("relay state lock poisoned");
            state.next_message = state
                .next_message
                .checked_add(1)
                .context("relay client message id space exhausted")?;
            let message_id = format!("{}-{}", state.message_prefix, state.next_message);
            state.outbox.push(OutboundMessage {
                message_id,
                payload: payload.clone(),
            });
            Ok(())
        })();
        if let Err(error) = result {
            logger::info(&format!("Failed to queue relay message: {error:#}"));
        }
        self.changed.notify_one();
    }

    fn pending(&self) -> Vec<OutboundMessage> {
        self.state
            .lock()
            .expect("relay state lock poisoned")
            .outbox
            .clone()
    }

    fn mark_stored(&self, message_id: &str) {
        let mut state = self.state.lock().expect("relay state lock poisoned");
        state
            .outbox
            .retain(|message| message.message_id != message_id);
    }

    fn last_received(&self) -> Option<u64> {
        self.state
            .lock()
            .expect("relay state lock poisoned")
            .last_received
    }

    fn mark_received(&self, sequence: u64) {
        let mut state = self.state.lock().expect("relay state lock poisoned");
        state.last_received = Some(sequence);
    }
}

/// Start the remote RPC transport with the pairing id supplied by the
/// extension. The service endpoint is the built-in local relay URL.
pub fn start(relay_id: &str) -> Result<Peer> {
    validate_relay_id(relay_id)?;
    let outbox = MemoryOutbox::new()?;
    let writer_outbox = outbox.clone();
    let peer = Peer::new(move |message| writer_outbox.enqueue(message));
    browser_agent::register(&peer);
    tokio::spawn(run(relay_id.to_string(), outbox, peer.clone()));
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

fn is_new_sequence(last_received: Option<u64>, sequence: u64) -> Result<bool> {
    let Some(last_received) = last_received else {
        // The relay sequence is durable but this client's cursor is not. A new
        // process therefore adopts the first pending sequence as its baseline.
        return Ok(true);
    };
    if sequence <= last_received {
        return Ok(false);
    }
    let expected = last_received
        .checked_add(1)
        .context("relay receive sequence space exhausted")?;
    anyhow::ensure!(
        sequence == expected,
        "relay message sequence gap: expected {expected}, received {sequence}"
    );
    Ok(true)
}

enum ConnectionOutcome {
    Reconnect,
    Stop,
}

async fn run(relay_id: String, outbox: Arc<MemoryOutbox>, peer: Peer) {
    let mut reconnect_delay = MIN_RECONNECT_DELAY;
    loop {
        let mut connected = false;
        match run_connection(&relay_id, &outbox, &peer, &mut connected).await {
            Ok(ConnectionOutcome::Reconnect) => logger::info("Relay WebSocket disconnected"),
            Ok(ConnectionOutcome::Stop) => {
                logger::info(
                    "Relay connection stopped because this id and endpoint is already connected",
                );
                return;
            }
            Err(error) => logger::info(&format!("Relay WebSocket error: {error:#}")),
        }
        if connected {
            reconnect_delay = MIN_RECONNECT_DELAY;
        } else {
            reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
        }
        tokio::time::sleep(reconnect_delay).await;
    }
}

async fn run_connection(
    relay_id: &str,
    outbox: &Arc<MemoryOutbox>,
    peer: &Peer,
    connected: &mut bool,
) -> Result<ConnectionOutcome> {
    let url = endpoint_url(relay_id);
    let (socket, _) = connect_async(&url)
        .await
        .with_context(|| format!("failed to connect to relay at {url}"))?;
    *connected = true;
    logger::info("Connected to relay WebSocket");
    let (mut sink, mut stream) = socket.split();
    let mut sent = HashSet::new();
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
        HEARTBEAT_INTERVAL,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        for message in outbox.pending() {
            if !sent.insert(message.message_id.clone()) {
                continue;
            }
            send_frame(
                &mut sink,
                &ClientFrame::Message {
                    message_id: message.message_id,
                    payload: message.payload,
                },
            )
            .await?;
        }

        tokio::select! {
            _ = outbox.changed.notified() => {}
            _ = heartbeat.tick() => {
                sink.send(Message::Ping(Vec::new().into())).await?;
            }
            incoming = stream.next() => {
                let incoming = incoming.context("relay WebSocket closed")??;
                let Message::Text(text) = incoming else {
                    if matches!(incoming, Message::Close(_)) {
                        return Ok(ConnectionOutcome::Reconnect);
                    }
                    continue;
                };
                let frame: ServerFrame = serde_json::from_str(&text)
                    .context("relay returned an invalid frame")?;
                match frame {
                    ServerFrame::Ready { endpoint } => {
                        anyhow::ensure!(
                            endpoint == Endpoint::One,
                            "relay connected this client as endpoint {endpoint}"
                        );
                    }
                    ServerFrame::Stored { message_id } => {
                        outbox.mark_stored(&message_id);
                        sent.remove(&message_id);
                    }
                    ServerFrame::Message { sequence, payload, .. } => {
                        if is_new_sequence(outbox.last_received(), sequence)? {
                            peer.dispatch(payload).await;
                            outbox.mark_received(sequence);
                        }
                        send_frame(&mut sink, &ClientFrame::Ack { sequence }).await?;
                    }
                    ServerFrame::Error { message } => {
                        if message.starts_with("connection_conflict:") {
                            return Ok(ConnectionOutcome::Stop);
                        }
                        anyhow::bail!("relay rejected a frame: {message}");
                    }
                }
            }
        }
    }
}

async fn send_frame<S>(sink: &mut S, frame: &ClientFrame) -> Result<()>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let json = serde_json::to_string(frame)?;
    sink.send(Message::Text(json.into())).await?;
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

    #[test]
    fn accepts_any_first_sequence_then_requires_contiguous_messages() {
        assert!(is_new_sequence(None, 42).unwrap());
        assert!(is_new_sequence(Some(42), 43).unwrap());
        assert!(!is_new_sequence(Some(42), 42).unwrap());
        assert!(is_new_sequence(Some(42), 44).is_err());
    }
}
