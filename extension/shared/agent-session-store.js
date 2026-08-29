import { localStorageKeys } from './storage-keys.js';

const emptyAgentPanelState = () => ({
  sessions: [],
  defaults: {
    agent: '',
    configOptionsByAgent: {},
  },
});

/** JSON tuple encoding is unambiguous even when an ACP session id contains
 * punctuation used by either agent. */
export function agentSessionKey(agent, sessionId) {
  return JSON.stringify([agent, sessionId]);
}

export function sessionTitleFromPrompt(prompt, maxLength = 60) {
  const normalized = typeof prompt === 'string' ? prompt.trim().replace(/\s+/g, ' ') : '';
  const characters = Array.from(normalized);
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join('')}…` : normalized;
}

function normalizeState(value) {
  if (!value || typeof value !== 'object') return emptyAgentPanelState();
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.filter(
        (session) =>
          session &&
          session.draft !== true &&
          typeof session.agent === 'string' &&
          session.agent &&
          typeof session.sessionId === 'string' &&
          session.sessionId,
      )
    : [];
  const defaults = value.defaults && typeof value.defaults === 'object' ? value.defaults : {};
  const configOptionsByAgent =
    defaults.configOptionsByAgent && typeof defaults.configOptionsByAgent === 'object'
      ? Object.fromEntries(
          Object.entries(defaults.configOptionsByAgent).filter(
            ([agent, configOptions]) => agent && Array.isArray(configOptions),
          ),
        )
      : {};
  return {
    sessions: sortSessions(
      sessions.map((session) => ({
        ...session,
        key: agentSessionKey(session.agent, session.sessionId),
      })),
    ),
    defaults: {
      agent: typeof defaults.agent === 'string' ? defaults.agent : '',
      configOptionsByAgent,
    },
  };
}

function sortSessions(sessions) {
  return sessions.slice().sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || a.createdAt || '') || 0;
    const bTime = Date.parse(b.updatedAt || b.createdAt || '') || 0;
    return bTime - aTime;
  });
}

export function upsertStoredSession(state, session) {
  const key = agentSessionKey(session.agent, session.sessionId);
  const nextSession = { ...session, key };
  const sessions = state.sessions.some((item) => item.key === key)
    ? state.sessions.map((item) => (item.key === key ? { ...item, ...nextSession } : item))
    : [nextSession, ...state.sessions];
  return { ...state, sessions: sortSessions(sessions) };
}

export function removeStoredSession(state, key) {
  return { ...state, sessions: state.sessions.filter((session) => session.key !== key) };
}

export async function readAgentPanelState() {
  const stored = await chrome.storage.local.get(localStorageKeys.agentPanelState);
  return normalizeState(stored[localStorageKeys.agentPanelState]);
}

let writeQueue = Promise.resolve();

/** Serialize writes originating in one extension page and always mutate the
 * freshest stored value, so session and default updates cannot overwrite one
 * another within that page. */
export function updateAgentPanelState(update) {
  const task = writeQueue.then(async () => {
    const current = await readAgentPanelState();
    const next = normalizeState(update(current));
    await chrome.storage.local.set({ [localStorageKeys.agentPanelState]: next });
    return next;
  });
  writeQueue = task.catch(() => {});
  return task;
}

export function observeAgentPanelState(callback) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    const change = changes[localStorageKeys.agentPanelState];
    if (!change) return;
    callback(normalizeState(change.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
