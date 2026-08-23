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
  let permissionHandler = null;
  let sessionEndedHandler = null;
  let hostReconnectedHandler = null;

  function rpc() {
    if (peer) return peer;
    port = chrome.runtime.connect({ name: 'agent-rpc' });
    peer = new RpcPeer((msg) => port.postMessage(msg), 'p');
    peer.onNotify('agent_session_ended', (params) => {
      if (typeof params?.sessionId === 'string') sessionEndedHandler?.(params.sessionId);
    });
    peer.onNotify('host_reconnected', () => hostReconnectedHandler?.());
    peer.handle('agent_permission_request', async (request) => {
      if (!permissionHandler) throw new Error('No permission UI available');
      const optionId = await permissionHandler(request);
      if (typeof optionId !== 'string' || !optionId) {
        throw new Error('Permission request cancelled');
      }
      return { optionId };
    });
    port.onMessage.addListener((msg) => peer.dispatch(msg));
    port.onDisconnect.addListener(() => {
      peer.rejectAll(new Error(chrome.runtime.lastError?.message || 'Background disconnected'));
      peer = null;
      port = null;
    });
    return peer;
  }

  return {
    setPermissionHandler(handler) {
      permissionHandler = typeof handler === 'function' ? handler : null;
      if (permissionHandler) rpc();
    },

    /** Register a callback for host-side session termination (agent crash or
     * ACP connection reconnect). Receives the ACP session id. */
    setSessionEndedHandler(handler) {
      sessionEndedHandler = typeof handler === 'function' ? handler : null;
    },

    /** Register a callback for the native host process being replaced (crash
     * or service worker restart): no live session survives it. */
    setHostReconnectedHandler(handler) {
      hostReconnectedHandler = typeof handler === 'function' ? handler : null;
    },

    completeCwd(input = '', options = {}) {
      const params = { input, limit: options.limit, timeoutSeconds: options.timeoutSeconds };
      return rpc().call('agent_cwd_complete', params, options);
    },

    /** Create a persistent agent session. Returns `{ sessionId, modes,
     * configOptions }`: `sessionId` is the agent-side ACP session id — use
     * it for `ask` now, and persist it for `loadSession` later. */
    createSession(options = {}) {
      const params = {
        cwd: options.cwd,
        panelContext: options.panelContext,
        timeoutSeconds: options.timeoutSeconds,
      };
      return rpc().call('agent_session_create', params, options);
    },

    /** Send a prompt and resolve to the answer text. With
     * `options.onEvent`, events are also streamed:
     * `{ event: 'session_update', update }` (ACP session updates, text
     * chunks included) and finally `{ event: 'stop', stop_reason }`.
     * An empty `prompt` is allowed when attachments carry the content.
     * Attachments wire format, passed through as-is:
     * `[{ type: 'image', data: '<base64>', mimeType },
     *   { type: 'text', text: '<file contents>' },
     *   { type: 'resource', uri, name, mimeType? }]` */
    async ask(prompt, options = {}) {
      const hasAttachments = Array.isArray(options.attachments) && options.attachments.length > 0;
      if ((typeof prompt !== 'string' || !prompt.trim()) && !hasAttachments) {
        return Promise.reject(new Error('ask requires a non-empty prompt or attachments'));
      }
      if (typeof options.sessionId !== 'string' || !options.sessionId) {
        return Promise.reject(new Error('ask requires a sessionId'));
      }
      const params = {
        prompt,
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

    /** Switch the live session mode (`session/set_mode`), e.g. plan mode.
     * Mode ids come from `createSession` / `loadSession` responses. */
    setSessionMode(sessionId, modeId, options = {}) {
      if (typeof sessionId !== 'string' || !sessionId) {
        return Promise.reject(new Error('setSessionMode requires a sessionId'));
      }
      if (typeof modeId !== 'string' || !modeId) {
        return Promise.reject(new Error('setSessionMode requires a modeId'));
      }
      return rpc().call('agent_session_set_mode', { sessionId, modeId }, options);
    },

    /** Set a live session config option (`session/set_config_option`), e.g.
     * `model` or `effort`; ids and values come from the session's
     * `configOptions`. Resolves to the refreshed config options. */
    setSessionConfigOption(sessionId, configId, value, options = {}) {
      if (typeof sessionId !== 'string' || !sessionId) {
        return Promise.reject(new Error('setSessionConfigOption requires a sessionId'));
      }
      if (typeof configId !== 'string' || !configId) {
        return Promise.reject(new Error('setSessionConfigOption requires a configId'));
      }
      if (typeof value !== 'string' || !value) {
        return Promise.reject(new Error('setSessionConfigOption requires a string value'));
      }
      return rpc().call('agent_session_set_config_option', { sessionId, configId, value }, options);
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

    /** List the first page of agent-persisted sessions. */
    listSessions(options = {}) {
      const params = { cwd: options.cwd, timeoutSeconds: options.timeoutSeconds };
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
        panelContext: options.panelContext,
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
