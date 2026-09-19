//! Optional PSK encryption above the unchanged Relay protocol. See docs/relay-encryption.md.

use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

const PREFIX: &str = "adk1_";
const PROTOCOL: &str = "agentdeck-e2ee-v1";

pub fn is_plain_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    e2ee: u8,
    sender: String,
    nonce: String,
    ciphertext: String,
}

pub struct RelayEncryption {
    pub route_id: String,
    send_key: [u8; 32],
    receive_key: [u8; 32],
}

impl RelayEncryption {
    pub fn new(id: &str) -> Result<Self> {
        let encoded = id
            .strip_prefix(PREFIX)
            .context("Invalid pairing ID; expected UUID or adk1_ ID")?;
        let mut secret = URL_SAFE_NO_PAD
            .decode(encoded)
            .context("Invalid encrypted pairing ID")?;
        ensure!(secret.len() == 32, "Invalid encrypted pairing ID");
        let hkdf = Hkdf::<Sha256>::new(Some(PROTOCOL.as_bytes()), &secret);
        let derive = |label: &[u8]| -> Result<[u8; 32]> {
            let mut key = [0; 32];
            hkdf.expand(label, &mut key)
                .map_err(|_| anyhow::anyhow!("Key derivation failed"))?;
            Ok(key)
        };
        let result = Self {
            route_id: format!("adr1_{}", URL_SAFE_NO_PAD.encode(derive(b"route")?)),
            send_key: derive(b"host-to-app")?,
            receive_key: derive(b"app-to-host")?,
        };
        secret.fill(0);
        Ok(result)
    }

    fn aad(&self, frame: &Envelope, direction: &str) -> Vec<u8> {
        serde_json::to_vec(&(PROTOCOL, &self.route_id, direction, &frame.sender))
            .expect("serialize AAD")
    }

    pub fn seal(&self, message: Value) -> Result<Value> {
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let mut frame = Envelope {
            e2ee: 1,
            sender: "host".into(),
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: String::new(),
        };
        let ciphertext = XChaCha20Poly1305::new((&self.send_key).into())
            .encrypt(
                &nonce,
                Payload {
                    msg: &serde_json::to_vec(&message)?,
                    aad: &self.aad(&frame, "host-to-app"),
                },
            )
            .map_err(|_| anyhow::anyhow!("Message encryption failed"))?;
        frame.ciphertext = URL_SAFE_NO_PAD.encode(ciphertext);
        Ok(serde_json::to_value(frame)?)
    }

    pub fn open(&self, value: Value) -> Result<(String, Value)> {
        let frame: Envelope = serde_json::from_value(value).context("Invalid encrypted message")?;
        ensure!(
            frame.e2ee == 1
                && !frame.sender.is_empty()
                && frame.sender != "host"
                && frame.sender.len() <= 256,
            "Invalid encrypted message"
        );
        let nonce = URL_SAFE_NO_PAD
            .decode(&frame.nonce)
            .context("Invalid encrypted nonce")?;
        ensure!(nonce.len() == 24, "Invalid encrypted nonce");
        let ciphertext = URL_SAFE_NO_PAD
            .decode(&frame.ciphertext)
            .context("Invalid encrypted message encoding")?;
        let plaintext = XChaCha20Poly1305::new((&self.receive_key).into())
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &self.aad(&frame, "app-to-host"),
                },
            )
            .map_err(|_| anyhow::anyhow!("Message authentication failed"))?;
        let message: Value = serde_json::from_slice(&plaintext).context("Invalid encrypted RPC")?;
        ensure!(message.is_object(), "Invalid encrypted RPC");
        Ok((frame.sender, message))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vector() -> Value {
        serde_json::from_str(include_str!("../test/fixtures/e2ee-v1.json")).unwrap()
    }

    #[test]
    fn typescript_vector_decrypts_without_message_state() {
        let v = vector();
        let id = v["id"].as_str().unwrap();
        let codec = RelayEncryption::new(id).unwrap();
        assert_eq!(codec.route_id, v["routeId"]);
        for _ in 0..2 {
            let (sender, message) = codec.open(v["appFrame"].clone()).unwrap();
            assert_eq!(sender, "test-phone");
            assert_eq!(message, v["appMessage"]);
        }
        let restarted = RelayEncryption::new(id).unwrap();
        assert_eq!(
            restarted.open(v["appFrame"].clone()).unwrap().1,
            v["appMessage"]
        );
        let first = codec.seal(json!({"result": "hello"})).unwrap();
        let second = codec.seal(json!({"result": "hello"})).unwrap();
        assert_ne!(first["nonce"], second["nonce"]);
        assert!(first.get("sequence").is_none());
    }

    #[test]
    fn authentication_rejects_plaintext_wrong_keys_and_tampering() {
        let v = vector();
        let id = v["id"].as_str().unwrap();
        for (field, value) in [
            ("sender", json!("other-phone")),
            ("e2ee", json!(2)),
            ("nonce", json!(URL_SAFE_NO_PAD.encode([0; 24]))),
            ("ciphertext", json!(URL_SAFE_NO_PAD.encode([0; 32]))),
        ] {
            let codec = RelayEncryption::new(id).unwrap();
            let mut frame = v["appFrame"].clone();
            frame[field] = value;
            assert!(codec.open(frame).is_err(), "{field}");
            assert_eq!(
                codec.open(v["appFrame"].clone()).unwrap().1,
                v["appMessage"]
            );
        }
        let codec =
            RelayEncryption::new(&format!("adk1_{}", URL_SAFE_NO_PAD.encode([42; 32]))).unwrap();
        assert!(codec.open(v["appFrame"].clone()).is_err());
        assert!(codec.open(json!({"method": "agent_list"})).is_err());
        assert!(codec.open(v["hostFrame"].clone()).is_err());
        for id in ["adk2_bad", "adk1_bad", "adk1_", "secret"] {
            assert!(RelayEncryption::new(id).is_err());
        }
    }

    #[test]
    fn host_key_matches_typescript_vector() {
        let v = vector();
        let codec = RelayEncryption::new(v["id"].as_str().unwrap()).unwrap();
        let frame: Envelope = serde_json::from_value(v["hostFrame"].clone()).unwrap();
        let nonce = URL_SAFE_NO_PAD.decode(&frame.nonce).unwrap();
        let ciphertext = URL_SAFE_NO_PAD.decode(&frame.ciphertext).unwrap();
        let plaintext = XChaCha20Poly1305::new((&codec.send_key).into())
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &codec.aad(&frame, "host-to-app"),
                },
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&plaintext).unwrap(),
            v["hostMessage"]
        );
    }
}
