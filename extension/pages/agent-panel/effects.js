import { addListener } from '@mantou/gem/lib/utils';
import { observeAgentPanelState, readAgentPanelState } from '../../shared/agent-session-store.js';

/** Load the data required before the panel leaves its initial full-page loader. */
export function mountBootstrap({ state, api }) {
  let active = true;
  const update = (patch) => active && state(patch);

  const loadAgents = async () => {
    try {
      const { agents } = await api.listAgents();
      update({ agents: agents || [] });
    } catch (e) {
      update({ error: e.message });
    }
  };

  const loadHome = async () => {
    try {
      const { value } = await api.completeCwd('');
      update({ home: value || '' });
    } catch {
      // Home shortening is optional; absolute paths remain usable.
    }
  };

  void (async () => {
    try {
      try {
        const stored = await readAgentPanelState();
        update({ sessions: stored.sessions, defaults: stored.defaults });
      } catch (e) {
        update({ error: e.message });
      }
      await Promise.all([loadHome(), loadAgents()]);
    } finally {
      update({ booting: false });
    }
  })();

  return () => {
    active = false;
  };
}

export function mountStoredState(state) {
  return observeAgentPanelState(({ sessions, defaults }) => state({ sessions, defaults }));
}

export function mountCompactMode(state) {
  const mediaQuery = matchMedia('(width <= 1280px)');
  state({ compact: mediaQuery.matches });
  return addListener(mediaQuery, 'change', ({ matches }) => state({ compact: matches }));
}

export function mountAgentApi({ api, sessions, turns }) {
  api.setPermissionHandler(turns.requestPermission);
  api.setSessionEndedHandler(sessions.handleSessionEnded);
  api.setHostReconnectedHandler(sessions.handleHostReconnect);
  return () => {
    turns.declineAllPermissions();
    api.setPermissionHandler(null);
    api.setSessionEndedHandler(null);
    api.setHostReconnectedHandler(null);
  };
}
