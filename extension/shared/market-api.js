import { initRequest } from '@mantou/gem/helper/request';

export const MARKET_API =
  import.meta.env.MODE === 'development'
    ? 'http://127.0.0.1:8787'
    : 'https://browser4agent-market.709922234.workers.dev';

const AUTH_TOKEN_KEY = 'authToken';

let authReady = null;

export function ensureAuthToken() {
  if (authReady) return authReady;
  authReady = (async () => {
    const stored = (await chrome.storage.sync.get(AUTH_TOKEN_KEY))[AUTH_TOKEN_KEY];
    if (typeof stored === 'string' && stored) return stored;
    const token = crypto.randomUUID();
    await chrome.storage.sync.set({ [AUTH_TOKEN_KEY]: token });
    return token;
  })();
  return authReady;
}

export const marketApi = initRequest({
  origin: MARKET_API,
  appendHeaders: async () => ({ authorization: `Bearer ${await ensureAuthToken()}` }),
});
