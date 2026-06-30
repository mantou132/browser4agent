use std::{collections::HashMap, sync::Arc};

use tokio::sync::{Mutex, oneshot};

use crate::{logger, native_messaging::write_with_request_id};

/// Request/response helper for native host initiated calls into the extension.
#[derive(Clone)]
pub struct ExtensionRpcClient {
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_id: Arc<Mutex<u64>>,
}

impl ExtensionRpcClient {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(0)),
        }
    }

    /// Send a request to the extension and return a oneshot receiver for the
    /// response.
    pub async fn request(&self, msg: &serde_json::Value) -> oneshot::Receiver<serde_json::Value> {
        let mut id = self.next_id.lock().await;
        *id += 1;
        let req_id = *id;
        drop(id);

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(req_id, tx);

        let out = write_with_request_id(Some(serde_json::json!(req_id)), msg.clone())
            .expect("request_id was provided");
        logger::log(&format!("Sent request to extension: {:?}", out));

        rx
    }

    /// Deliver a response from the extension to the waiting oneshot.
    pub async fn deliver_response(&self, request_id: u64, mut response: serde_json::Value) -> bool {
        if let Some(tx) = self.pending.lock().await.remove(&request_id) {
            if let Some(map) = response.as_object_mut() {
                map.remove("request_id");
            }
            let _ = tx.send(response);
            true
        } else {
            false
        }
    }
}
