/**
 * Symmetric duplex RPC peer.
 *
 * Every message is a plain object, classified by shape:
 * - request:      `{ id, method, params? }`
 * - response:     `{ id, result }` or `{ id, error }`
 * - stream event: `{ id, event }` — intermediate frame tied to a request
 * - notification: `{ method, params? }` — no id, fire and forget
 *
 * Both sides of a link use the same API: `call` / `notify` to initiate,
 * `handle` / `onNotify` to serve. Construct it with a `send(msg)` transport
 * function; a throwing `send` rejects the pending `call` and is logged
 * elsewhere. Used for the native host link and the devtools panel link.
 */
export class RpcPeer {
  #nextId = 0;
  #pending = new Map();
  #handlers = new Map();
  #notifyHandlers = new Map();
  #send;
  #idPrefix;

  constructor(send, idPrefix = '') {
    this.#send = send;
    this.#idPrefix = idPrefix;
  }

  /** Call the remote peer and await its final result. Timeout policy lives
   * with the remote handler; a dead transport rejects via `rejectAll`. */
  call(method, params = {}, { onEvent } = {}) {
    const id = `${this.#idPrefix}${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onEvent });
      try {
        this.#send({ id, method, params });
      } catch (e) {
        this.#pending.delete(id);
        reject(e);
      }
    });
  }

  /** Send a fire-and-forget notification. */
  notify(method, params = {}) {
    try {
      this.#send({ method, params });
    } catch (e) {
      console.error(`Failed to send notification: ${method}`, e);
    }
  }

  /**
   * Register an async handler for requests from the remote peer. Its return
   * value becomes the response; a thrown error is reported back as `{ error }`.
   * `ctx.emit(event)` streams intermediate frames before the final result.
   */
  handle(method, handler) {
    this.#handlers.set(method, handler);
  }

  /** Register a handler for notifications from the remote peer. */
  onNotify(method, handler) {
    this.#notifyHandlers.set(method, handler);
  }

  /** Route one incoming message. */
  async dispatch(msg) {
    const { id, method } = msg;
    if (id !== undefined && method !== undefined) {
      this.#dispatchRequest(id, method, msg.params);
    } else if (id !== undefined) {
      this.#dispatchReply(id, msg);
    } else if (method !== undefined) {
      const handler = this.#notifyHandlers.get(method);
      if (handler) {
        handler(msg.params);
      } else {
        console.warn('Unhandled notification:', method);
      }
    } else {
      console.warn('Message without id or method:', msg);
    }
  }

  /** Reject all in-flight requests (remote peer disconnected). */
  rejectAll(error) {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /** Send a frame back, tolerating a transport that already went away. */
  #post(msg) {
    try {
      this.#send(msg);
    } catch (e) {
      console.error('Failed to send RPC frame:', e);
    }
  }

  async #dispatchRequest(id, method, params) {
    const handler = this.#handlers.get(method);
    if (!handler) {
      this.#post({ id, error: `Unknown method: ${method}` });
      return;
    }
    try {
      const result = await handler(params ?? {}, { emit: (event) => this.#post({ id, event }) });
      this.#post({ id, result: result ?? null });
    } catch (e) {
      this.#post({ id, error: e?.message || String(e) });
    }
  }

  #dispatchReply(id, msg) {
    // Stream event frame: intermediate, the pending request stays open.
    if ('event' in msg) {
      this.#pending.get(id)?.onEvent?.(msg.event);
      return;
    }
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    if (!pending) return;
    if ('error' in msg) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }
}
