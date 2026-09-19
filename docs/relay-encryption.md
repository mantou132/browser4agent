# Optional Relay encryption, version 1

The user still copies one ID from the extension and pastes it into AgentDeck.
New extension installations generate `adk1_` followed by the unpadded canonical
Base64URL encoding of 32 cryptographically random bytes. Existing UUIDs keep the
legacy plaintext protocol. Unknown versions and malformed IDs are rejected; an
encrypted connection never falls back to plaintext. There is no mode switch.
Both App and Native Host must support this protocol.

## Key derivation and wire format

Decode the 32-byte secret and use HKDF-SHA256 with UTF-8 salt
`agentdeck-e2ee-v1`. Each output is 32 bytes, using these exact UTF-8 info labels:

| Label | Use |
| --- | --- |
| `route` | `adr1_` + Base64URL(output), the Relay room ID |
| `app-to-host` | App send / Host receive key |
| `host-to-app` | Host send / App receive key |

Only the derived route is passed to the Relay SDK, including its persistence
store. The original pairing ID is never sent to Relay or written to logs. The
Relay service and its protocol are unchanged. Production continues to use WSS.

Each Relay payload is `{e2ee: 1, sender, nonce, ciphertext}`. Encrypt the
UTF-8 JSON of the entire RPC object using XChaCha20-Poly1305. Generate an independent
random 24-byte nonce for each new message. `nonce` and the combined ciphertext/tag
are unpadded canonical Base64URL. Additional authenticated data is the compact
UTF-8 JSON array `["agentdeck-e2ee-v1", routeId, direction, sender]`.
Direction is the matching key derivation label. Sender is the App's device ID or
the literal `host`. Device IDs used by the App are ASCII UUIDs.

The Host binds an encrypted `peer_attach` to the authenticated sender and
subsequently verifies the sender's assigned `peerId`.

## Queues and persistence

Encrypt before adding to the SDK outbox. Retries send the same envelope. App
timeout/rejection correlation decrypts only its own locally queued messages.
The 10 MiB WebSocket limit is checked against the final encoded encrypted frame,
so Base64 expansion reduces the maximum application payload size. Oversized Host
responses become a small encrypted RPC error instead of entering an endless
reconnect/resend loop.

Encryption is stateless: it only holds the derived keys in memory and generates
a fresh random nonce for each new message. It has no message counters, receive
history, localStorage entries, or state files. The existing Relay SDK handles
its own queues, receive cursors, and retransmissions. App connection reset clears
the Relay queue/cursor and retains the pairing settings and device ID.

App and Host must be updated together when changing the encrypted envelope or AAD.

## Security scope

This is shared-secret encryption between the App and Host. Relay sees routing,
device metadata, sizes and timing, and can delay/drop messages. Encryption adds
no replay protection if Relay rewraps old ciphertext as a new message. All devices with
the same pairing ID belong to the same trust group and can derive both keys.
Revoking one requires a new pairing ID for the group. There is no forward secrecy:
disclosing the ID can expose previously recorded ciphertext. Previously used
plaintext UUIDs must not be reused as encryption secrets.

The App stores its pairing ID in existing local settings and the extension stores
it in existing browser local storage. Endpoint compromise, local history/storage
encryption, and Host-to-model-provider traffic are outside this protocol's scope.

`test/fixtures/e2ee-v1.json` is shared byte-for-byte with browser-mcp and tested in
TypeScript and Rust. It uses public deterministic test secrets, never production IDs.
