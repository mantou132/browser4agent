use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::{logger, native_messaging::write_native_message};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Event emitter passed to request handlers for streaming intermediate frames
/// back to the caller before the final result.
#[derive(Clone)]
pub struct CallCtx {
    emit: Arc<dyn Fn(Value) + Send + Sync>,
}

impl CallCtx {
    pub fn emit(&self, event: Value) {
        (self.emit)(event);
    }
}

type Handler =
    Arc<dyn Fn(Value, CallCtx) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;
type Writer = Arc<dyn Fn(Value) + Send + Sync>;

struct Pending {
    reply: oneshot::Sender<Result<Value, String>>,
    on_event: Option<Arc<dyn Fn(Value) + Send + Sync>>,
}

/// Symmetric duplex RPC peer over native messaging.
///
/// Every message is a JSON object, classified by shape:
/// - request:      `{ id, method, params? }`
/// - response:     `{ id, result }` or `{ id, error }`
/// - stream event: `{ id, event }` — intermediate frame tied to a request
/// - notification: `{ method, params? }` — no id, fire and forget
///
/// Both sides use the same API: `call` / `notify` to initiate,
/// `handle` / `on_notify` to serve.
#[derive(Clone)]
pub struct Peer {
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    handlers: Arc<Mutex<HashMap<String, Handler>>>,
    notify_handlers: Arc<Mutex<HashMap<String, Arc<dyn Fn(Value) + Send + Sync>>>>,
    next_id: Arc<Mutex<u64>>,
    writer: Writer,
}

impl Default for Peer {
    fn default() -> Self {
        Self::new(write_native_message)
    }
}

impl Peer {
    /// Create an RPC peer whose outgoing frames use the supplied transport.
    /// Each transport must have its own `Peer`, keeping request ids and replies
    /// isolated even when several clients control the same native host.
    pub fn new<F>(writer: F) -> Self
    where
        F: Fn(&Value) + Send + Sync + 'static,
    {
        Self {
            pending: Arc::default(),
            handlers: Arc::default(),
            notify_handlers: Arc::default(),
            next_id: Arc::default(),
            writer: Arc::new(move |message| writer(&message)),
        }
    }

    fn write(&self, message: Value) {
        (self.writer)(message);
    }

    /// Call the peer and await its final result.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_stream(method, params, None).await
    }

    /// Like [`Peer::call`], but also receives intermediate stream events.
    pub async fn call_stream(
        &self,
        method: &str,
        params: Value,
        on_event: Option<Arc<dyn Fn(Value) + Send + Sync>>,
    ) -> Result<Value> {
        let id = {
            let mut next = self.next_id.lock().expect("lock poisoned");
            *next += 1;
            format!("r{next}")
        };
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("lock poisoned").insert(
            id.clone(),
            Pending {
                reply: tx,
                on_event,
            },
        );

        self.write(json!({ "id": id, "method": method, "params": params }));

        match rx.await {
            Ok(result) => result.map_err(anyhow::Error::msg),
            Err(_) => Err(anyhow!("Peer disconnected before responding")),
        }
    }

    /// Send a fire-and-forget notification to the peer.
    pub fn notify(&self, method: &str, params: Value) {
        self.write(json!({ "method": method, "params": params }));
    }

    /// Register an async handler for requests from the peer. The handler's
    /// result becomes the response; use `CallCtx::emit` to stream events.
    pub fn handle<F, Fut>(&self, method: &str, f: F)
    where
        F: Fn(Value, CallCtx) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        let handler: Handler = Arc::new(move |params, ctx| Box::pin(f(params, ctx)));
        self.handlers
            .lock()
            .expect("lock poisoned")
            .insert(method.to_string(), handler);
    }

    /// Register a handler for notifications from the peer.
    pub fn on_notify<F>(&self, method: &str, f: F)
    where
        F: Fn(Value) + Send + Sync + 'static,
    {
        self.notify_handlers
            .lock()
            .expect("lock poisoned")
            .insert(method.to_string(), Arc::new(f));
    }

    /// Route one incoming message from the peer.
    pub async fn dispatch(&self, msg: Value) {
        let id = msg.get("id").and_then(|v| v.as_str()).map(str::to_string);
        let method = msg
            .get("method")
            .and_then(|v| v.as_str())
            .map(str::to_string);

        match (id, method) {
            (Some(id), Some(method)) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                self.dispatch_request(id, method, params);
            }
            (Some(id), None) => self.dispatch_reply(id, &msg),
            (None, Some(method)) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let handler = self
                    .notify_handlers
                    .lock()
                    .expect("lock poisoned")
                    .get(&method)
                    .cloned();
                if let Some(handler) = handler {
                    handler(params);
                } else {
                    logger::log(&format!("Unhandled notification: {method}"));
                }
            }
            (None, None) => logger::log(&format!("Message without id or method: {:?}", msg)),
        }
    }

    fn dispatch_request(&self, id: String, method: String, params: Value) {
        let handler = self
            .handlers
            .lock()
            .expect("lock poisoned")
            .get(&method)
            .cloned();
        let Some(handler) = handler else {
            self.write(json!({ "id": id, "error": format!("Unknown method: {method}") }));
            return;
        };

        let emit_id = id.clone();
        let event_peer = self.clone();
        let ctx = CallCtx {
            emit: Arc::new(move |event| {
                event_peer.write(json!({ "id": emit_id, "event": event }));
            }),
        };
        let reply_peer = self.clone();
        tokio::spawn(async move {
            let reply = match handler(params, ctx).await {
                Ok(result) => json!({ "id": id, "result": result }),
                Err(err) => json!({ "id": id, "error": err }),
            };
            reply_peer.write(reply);
        });
    }

    fn dispatch_reply(&self, id: String, msg: &Value) {
        let mut pending = self.pending.lock().expect("lock poisoned");

        // Stream event frame: keep the pending request alive.
        if let Some(event) = msg.get("event") {
            if let Some(entry) = pending.get(&id) {
                if let Some(on_event) = &entry.on_event {
                    on_event(event.clone());
                }
            } else {
                logger::log(&format!("Event for unknown request: {:?}", msg));
            }
            return;
        }

        let Some(entry) = pending.remove(&id) else {
            logger::log(&format!("No pending request for response: {:?}", msg));
            return;
        };
        let result = if let Some(error) = msg.get("error").and_then(|v| v.as_str()) {
            Err(error.to_string())
        } else {
            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
        };
        let _ = entry.reply.send(result);
    }
}
