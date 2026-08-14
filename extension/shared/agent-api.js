import { RpcPeer } from './rpc.js';

/**
 * Async client for the agent session API, served by the background service
 * worker over the `agent-rpc` runtime port (see `background.js`). Every
 * method is a plain async call; a streaming prompt delivers intermediate
 * events through `options.onEvent` while the promise resolves to the answer.
 * The port is opened lazily and reopened automatically after disconnects.
 */
export function createAgentApi() {
  let port = null;
  let peer = null;

  function rpc() {
    if (peer) return peer;
    port = chrome.runtime.connect({ name: 'agent-rpc' });
    peer = new RpcPeer((msg) => port.postMessage(msg), 'p');
    port.onMessage.addListener((msg) => peer.dispatch(msg));
    port.onDisconnect.addListener(() => {
      peer.rejectAll(new Error(chrome.runtime.lastError?.message || 'Background disconnected'));
      peer = null;
      port = null;
    });
    return peer;
  }

  return {
    /** Create a persistent agent session. Returns `{ sessionId, modes,
     * configOptions }`: `sessionId` is the agent-side ACP session id — use
     * it for `ask` now, and persist it for `loadSession` later. */
    createSession(options = {}) {
      const params = { cwd: options.cwd, timeoutSeconds: options.timeoutSeconds };
      return rpc().call('agent_session_create', params, options);
    },

    /** Send a prompt and resolve to the answer text. With
     * `options.onEvent`, events are also streamed:
     * `{ event: 'session_update', update }` (ACP session updates, text
     * chunks included) and finally `{ event: 'stop', stop_reason }`.
     * Attachments wire format, passed through as-is:
     * `[{ type: 'image', data: '<base64>', mimeType }, { type: 'resource', uri, name, mimeType? }]` */
    async ask(prompt, options = {}) {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return Promise.reject(new Error('ask requires a non-empty prompt'));
      }
      const params = {
        prompt,
        cwd: options.cwd,
        sessionId: options.sessionId,
        timeoutSeconds: options.timeoutSeconds,
        stream: Boolean(options.onEvent),
        attachments: options.attachments,
      };
      const result = await rpc().call('agent_prompt', params, options);
      return result.answer || '';
    },

    /** Cancel the in-flight prompt of a session. The pending `ask` call
     * settles with the partial answer, and the stream ends with a `stop`
     * event carrying the cancel reason. Returns false when the session is
     * unknown. */
    async cancelPrompt(sessionId, options = {}) {
      if (typeof sessionId !== 'string' || !sessionId) {
        return Promise.reject(new Error('cancelPrompt requires a sessionId'));
      }
      const result = await rpc().call('agent_prompt_cancel', { sessionId }, options);
      return result.cancelled;
    },

    async closeSession(sessionId, options = {}) {
      if (typeof sessionId !== 'string' || !sessionId) {
        return Promise.reject(new Error('closeSession requires a sessionId'));
      }
      const params = { sessionId, timeoutSeconds: options.timeoutSeconds };
      const result = await rpc().call('agent_session_close', params, options);
      return result.closed;
    },

    // Sessions persisted by the agent are addressed by their ACP session id,
    // not the live handle id.

    /** List agent-persisted sessions: `{ sessions, nextCursor? }`. Pass the
     * previous `nextCursor` as `options.cursor` to fetch the next page. */
    listSessions(options = {}) {
      const params = { cwd: options.cwd, cursor: options.cursor, timeoutSeconds: options.timeoutSeconds };
      return rpc().call('agent_session_list', params, options);
    },

    /** Resume an agent-persisted session by its ACP session id. Returns the
     * same shape as `createSession`; use `sessionId` for `ask`. With
     * `options.onEvent`, the agent's replayed history is streamed as
     * `session_update` events before the promise resolves. */
    loadSession(sessionId, options = {}) {
      if (typeof sessionId !== 'string' || !sessionId) {
        return Promise.reject(new Error('loadSession requires a sessionId'));
      }
      const params = {
        sessionId,
        cwd: options.cwd,
        timeoutSeconds: options.timeoutSeconds,
        stream: Boolean(options.onEvent),
      };
      return rpc().call('agent_session_load', params, options);
    },

    /** Delete an agent-persisted session by its ACP session id. */
    async deleteSession(sessionId, options = {}) {
      if (typeof sessionId !== 'string' || !sessionId) {
        return Promise.reject(new Error('deleteSession requires a sessionId'));
      }
      const params = { sessionId, timeoutSeconds: options.timeoutSeconds };
      const result = await rpc().call('agent_session_delete', params, options);
      return result.deleted;
    },
  };
}
