import { agentSessionKey, sessionTitleFromPrompt, upsertStoredSession } from '../../shared/agent-session-store.js';
import { t } from '../../shared/i18n.js';
import { completeThought, DRAFT_SESSION_KEY, withAgentConfigOptions, withConfigValue } from './session-runtime.js';

function getPanelContext() {
  const tabId = globalThis.chrome?.devtools?.inspectedWindow?.tabId;
  return Number.isInteger(tabId) ? { surface: 'devtools', tabId } : { surface: 'side_panel' };
}

export function createSessionController({ state, runtime, turns, api }) {
  // A cleared record makes a settling load inert after deletion/reconnect.
  const pendingLoads = new Map();

  const openNewSession = () => {
    if (state.loadingIds.includes(DRAFT_SESSION_KEY)) return;
    state({ newSessionOpen: true, error: '' });
  };

  const applyComposerConfig = async (target, configOptions, composerConfigOptions) => {
    let current = configOptions;
    for (const selected of composerConfigOptions) {
      const option = current.find((item) => item.id === selected.id);
      const value = selected.currentValue;
      const supported = option?.options?.some((item) => item.value === value);
      if (!value || !supported || option.currentValue === value) continue;
      const result = await api.setSessionConfigOption(target.sessionId, option.id, value, {
        agent: target.agent,
      });
      current = Array.isArray(result.configOptions) ? result.configOptions : withConfigValue(current, option.id, value);
    }
    return current;
  };

  /** Turn the single local draft into an ACP session, then deliver its first prompt. */
  const startDraftTurn = async (sessionKey, payload) => {
    const draft = runtime.record(sessionKey);
    const draftState = runtime.getPane(sessionKey);
    if (!draft?.draft || !draftState) return;
    let createdTarget;
    turns.stage(sessionKey, payload);
    runtime.setLoading(sessionKey, true);
    try {
      const created = await api.createSession({
        agent: draft.agent,
        cwd: draft.cwd,
        panelContext: getPanelContext(),
      });
      createdTarget = { agent: draft.agent, sessionId: created.sessionId };
      const composerConfigOptions = runtime.getPane(sessionKey)?.configOptions ?? draftState.configOptions;
      const configOptions = await applyComposerConfig(
        createdTarget,
        created.configOptions || [],
        composerConfigOptions,
      );
      const liveSessionKey = agentSessionKey(draft.agent, created.sessionId);
      const now = new Date().toISOString();
      const session = {
        key: liveSessionKey,
        agent: draft.agent,
        sessionId: created.sessionId,
        title: created.title || sessionTitleFromPrompt(payload.prompt),
        cwd: draft.cwd,
        createdAt: now,
        updatedAt: created.updatedAt || now,
      };
      const stagedPane = runtime.getPane(sessionKey) ?? draftState;
      const pane = {
        messages: stagedPane.messages,
        configOptions,
        cwd: draft.cwd,
        queue: stagedPane.queue,
      };
      const isCurrent = state.sessionKey === sessionKey;
      runtime.deletePane(sessionKey);
      runtime.setCachedPane(liveSessionKey, pane);
      state({ draftSession: null });
      runtime.setPending(sessionKey, false);
      runtime.setPending(liveSessionKey, true);
      if (isCurrent) {
        runtime.showPane(liveSessionKey, pane, { error: '' });
      }
      runtime.setLoading(sessionKey, false);
      const persistence = runtime.mutateStoredState((storedState) =>
        upsertStoredSession(withAgentConfigOptions(storedState, draft.agent, configOptions), session),
      );
      createdTarget = null;
      turns.run(liveSessionKey, payload, { staged: true });
      await persistence;
    } catch (e) {
      if (createdTarget) api.closeSession(createdTarget.sessionId, { agent: createdTarget.agent }).catch(() => {});
      runtime.setError(sessionKey, e.message);
      runtime.setPending(sessionKey, false);
      runtime.setLoading(sessionKey, false);
    }
  };

  /** Replace the existing empty draft, if any, with the newly selected settings. */
  const confirmNewSession = ({ agent, cwd }) => {
    runtime.snapshotCurrent();
    const now = new Date().toISOString();
    const draftSession = {
      key: DRAFT_SESSION_KEY,
      agent,
      title: '',
      cwd,
      createdAt: now,
      updatedAt: now,
      draft: true,
    };
    const configOptions = state.defaults.configOptionsByAgent[agent] || [];
    const pane = { messages: [], configOptions, cwd, queue: [] };
    runtime.setCachedPane(DRAFT_SESSION_KEY, pane);
    state({
      draftSession,
      sessionKey: DRAFT_SESSION_KEY,
      ...pane,
      newSessionOpen: false,
      error: '',
    });
    runtime.persistAgentDefault(agent);
  };

  const openSession = async (sessionKey) => {
    if (!sessionKey) return;
    const isCurrent = sessionKey === state.sessionKey;
    if (isCurrent && (runtime.hasCachedPane(sessionKey) || pendingLoads.has(sessionKey))) return;
    if (!isCurrent) runtime.snapshotCurrent();
    const selected = runtime.record(sessionKey);
    if (!selected) return;
    state({ error: '' });

    const cached = runtime.getCachedPane(sessionKey);
    if (cached) {
      runtime.showPane(sessionKey, cached);
      return;
    }

    runtime.clearError(sessionKey);
    state({
      sessionKey,
      cwd: selected.cwd || '',
      messages: [],
      configOptions: [],
      queue: [],
    });
    runtime.setLoading(sessionKey, true);
    const record = { alive: true };
    pendingLoads.set(sessionKey, record);
    try {
      await api.closeSession(selected.sessionId, { agent: selected.agent, timeoutSeconds: 3 }).catch(() => {});
      const { configOptions, title, updatedAt } = await api.loadSession(selected.sessionId, {
        agent: selected.agent,
        cwd: selected.cwd,
        onEvent: (event) => runtime.applyEvent(sessionKey, event),
        panelContext: getPanelContext(),
      });
      if (!record.alive) return;
      runtime.finishThought(sessionKey);
      if (title || updatedAt) {
        runtime.patchRecord(sessionKey, {
          ...(title && { title }),
          ...(updatedAt && { updatedAt }),
        });
      }
      if (state.sessionKey === sessionKey) {
        const pane = {
          messages: state.messages,
          configOptions: configOptions || [],
          cwd: state.cwd,
          queue: [],
        };
        runtime.setCachedPane(sessionKey, pane);
        state({ configOptions: pane.configOptions });
      } else if (runtime.hasCachedPane(sessionKey)) {
        const pane = runtime.getCachedPane(sessionKey);
        runtime.setCachedPane(sessionKey, {
          ...pane,
          messages: completeThought(pane.messages),
          configOptions: configOptions || [],
        });
      }
    } catch (e) {
      if (!record.alive) return;
      runtime.setError(sessionKey, e.message);
      runtime.deletePane(sessionKey);
    } finally {
      if (pendingLoads.get(sessionKey) === record) {
        pendingLoads.delete(sessionKey);
        runtime.setLoading(sessionKey, false);
      }
    }
  };

  const deleteSession = async (sessionKey) => {
    if (state.deleting) return;
    let selected = runtime.record(sessionKey);
    if (!selected) return;
    const loadRecord = pendingLoads.get(sessionKey);
    if (loadRecord) {
      loadRecord.alive = false;
      pendingLoads.delete(sessionKey);
      runtime.setLoading(sessionKey, false);
    }
    if (state.pendingIds.includes(sessionKey)) await turns.abort(sessionKey);
    selected = runtime.record(sessionKey) || selected;
    const isDraft = selected.draft === true && state.draftSession?.key === sessionKey;
    const isCurrent = state.sessionKey === sessionKey;
    const sessionList = runtime.list();
    const sessionIndex = sessionList.findIndex((session) => session.key === sessionKey);
    const fallbackKey =
      isCurrent && sessionIndex >= 0
        ? (sessionList[sessionIndex - 1]?.key ?? sessionList[sessionIndex + 1]?.key)
        : null;
    const previousSessions = state.sessions;
    const previousDraft = state.draftSession;
    state({ deleting: sessionKey });
    try {
      if (!isDraft && (isCurrent || loadRecord || runtime.hasCachedPane(sessionKey))) {
        await api.closeSession(selected.sessionId, { agent: selected.agent, timeoutSeconds: 3 }).catch(() => {});
      }
      if (!isDraft) {
        await api.deleteSession(selected.sessionId, { agent: selected.agent, timeoutSeconds: 5 }).catch(() => {});
        await runtime.removeRecord(sessionKey);
      }
      if (isDraft) {
        state({ draftSession: null });
      }
      runtime.deletePane(sessionKey);
      runtime.clearError(sessionKey);
      if (isCurrent) {
        if (fallbackKey) {
          await openSession(fallbackKey);
        } else {
          state({
            sessionKey: null,
            messages: [],
            configOptions: [],
            queue: [],
            cwd: '',
            error: '',
          });
        }
      }
    } catch (e) {
      state({ sessions: previousSessions, draftSession: previousDraft, error: e.message });
      return;
    } finally {
      state({ deleting: null });
    }
  };

  const changeConfig = async (configId, value) => {
    const sessionKey = state.sessionKey;
    if (!sessionKey) return;
    const session = runtime.record(sessionKey);
    if (!session) return;
    const previous = runtime.getPane(sessionKey)?.configOptions ?? [];
    runtime.clearError(sessionKey);
    const staged = withConfigValue(previous, configId, value);
    runtime.setPane(sessionKey, { configOptions: staged });
    if (session.draft) {
      await runtime.persistConfigOptions(session.agent, staged);
      return;
    }
    const target = runtime.target(sessionKey);
    if (!target) return;
    try {
      const { configOptions } = await api.setSessionConfigOption(target.sessionId, configId, value, {
        agent: target.agent,
      });
      const applied = Array.isArray(configOptions) ? configOptions : staged;
      runtime.setPane(sessionKey, { configOptions: applied });
      await runtime.persistConfigOptions(target.agent, applied);
    } catch (e) {
      runtime.setError(sessionKey, e.message);
      if (runtime.getPane(sessionKey)?.configOptions === staged) {
        runtime.setPane(sessionKey, { configOptions: previous });
      }
    }
  };

  const handleSessionEnded = ({ agent, sessionId }) => {
    const sessionKey = agentSessionKey(agent, sessionId);
    const record = pendingLoads.get(sessionKey);
    if (record) {
      record.alive = false;
      pendingLoads.delete(sessionKey);
      runtime.setLoading(sessionKey, false);
    }
    runtime.deletePane(sessionKey);
    turns.decidePermission(sessionKey, null);
    if (sessionKey === state.sessionKey) {
      state({
        sessionKey: null,
        messages: [],
        configOptions: [],
        queue: [],
        cwd: '',
      });
    }
  };

  const handleHostReconnect = () => {
    turns.declineAllPermissions();
    for (const record of pendingLoads.values()) record.alive = false;
    pendingLoads.clear();
    const draftLoading = runtime.resetPanesForReconnect();
    const currentSessionKey = state.sessionKey;
    const currentIsDraft = state.draftSession?.key === currentSessionKey;
    turns.clearCanceledSessions();
    state({
      loadingIds: draftLoading ? [DRAFT_SESSION_KEY] : [],
      pendingIds: [],
      permissions: {},
      sessionErrors: {},
      ...(!currentIsDraft &&
        currentSessionKey && {
          sessionKey: null,
          messages: [],
          configOptions: [],
          queue: [],
          cwd: '',
          error: t('devtoolsPanelHostReconnected'),
        }),
    });
  };

  return {
    openNewSession,
    startDraftTurn,
    confirmNewSession,
    openSession,
    deleteSession,
    changeConfig,
    handleSessionEnded,
    handleHostReconnect,
  };
}
