import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const encodeUrl = import.meta.resolve('duoyun-ui/lib/encode');
// Use the real encoder without loading the unrelated browser-only number/locale helpers.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === encodeUrl && specifier === './number') {
      return { shortCircuit: true, url: 'data:text/javascript,export const pseudoRandom = undefined;' };
    }
    return nextResolve(specifier, context);
  },
});
const { createEncryptedRelayId, loadRelayId } = await import('../shared/relay-id.js');
hooks.deregister();

test('new IDs contain 32 random bytes and are generated independently', () => {
  const id = createEncryptedRelayId();
  assert.match(id, /^adk1_[\w-]{43}$/);
  assert.equal(Buffer.from(id.slice(5), 'base64url').length, 32);
  assert.notEqual(createEncryptedRelayId(), id);
});

test('new installations persist encryption while existing UUIDs stay unchanged', async () => {
  const values = {};
  const storage = { get: async () => values, set: async (patch) => Object.assign(values, patch) };
  const encrypted = await loadRelayId(storage, 'id');
  assert.match(encrypted, /^adk1_/);
  assert.equal(await loadRelayId(storage, 'id'), encrypted);
  values.id = '01234567-89ab-cdef-0123-456789abcdef';
  assert.equal(await loadRelayId(storage, 'id'), values.id);
  assert.equal(values.id, '01234567-89ab-cdef-0123-456789abcdef');
});
