import { arrayBufferToBase64 } from 'duoyun-ui/lib/encode';

// New installations use a PSK pairing ID. Existing UUIDs keep their original mode.
export function createEncryptedRelayId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `adk1_${arrayBufferToBase64(bytes.buffer, true)}`;
}

export async function loadRelayId(storage, key) {
  const stored = (await storage.get(key))[key];
  if (typeof stored === 'string' && stored) return stored;
  const id = createEncryptedRelayId();
  await storage.set({ [key]: id });
  return id;
}
