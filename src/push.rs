use std::time::Duration;

use serde_json::json;

pub const PUSH_URL: &str = "https://agent-deck.xianqiao.wang/push";

pub async fn send(client: &reqwest::Client, token: &str, agent: &str, session_id: &str) {
    let payload = json!({
        "notifications": [{
            "tokens": [token],
            "platform": 2,
            "title": "Agent Deck",
            "priority": "high",
            "android": {
                "notification": {
                    "channel_id": "agent_responses",
                    "body_loc_key": "notification_response_complete",
                    "tag": format!("{agent}:{session_id}")
                }
            },
            "data": { "type": "response_complete", "agent": agent, "sessionId": session_id }
        }]
    });
    let _ = client
        .post(PUSH_URL)
        .timeout(Duration::from_secs(10))
        .json(&payload)
        .send()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sends_one_notification_with_routing_metadata_and_no_conversation_content() {
        use axum::{Json, Router, routing::post};
        use serde_json::Value;

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/push",
            post(move |Json(payload): Json<Value>| {
                let tx = tx.clone();
                async move {
                    tx.send(payload).unwrap();
                    Json(json!({"success":"ok","counts":1,"logs":[]}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let payload = json!({
            "notifications": [{
                "tokens": ["phone-a"],
                "platform": 2,
                "title": "Agent Deck",
                "priority": "high",
                "android": {
                    "notification": {
                        "channel_id": "agent_responses",
                        "body_loc_key": "notification_response_complete",
                        "tag": "codex:session-a"
                    }
                },
                "data": { "type": "response_complete", "agent": "codex", "sessionId": "session-a" }
            }]
        });
        let client = reqwest::Client::new();
        let _ = client
            .post(format!("http://{addr}/push"))
            .json(&payload)
            .send()
            .await;

        let received = rx.recv().await.unwrap();
        assert_eq!(received["notifications"][0]["tokens"], json!(["phone-a"]));
        assert_eq!(
            received["notifications"][0]["data"]["sessionId"],
            "session-a"
        );
        assert!(received["notifications"][0].get("message").is_none());
        server.abort();
    }
}
