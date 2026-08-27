import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  emptyAgentPanelState,
  readAgentPanelState,
  sessionTitleFromPrompt,
  updateAgentPanelState,
  upsertStoredSession,
} = await import('../shared/agent-session-store.js');

describe('agent session storage', () => {
  it('keeps agent session keys distinct', () => {
    const sessions = [
      { agent: 'claude', sessionId: 'same' },
      { agent: 'codex', sessionId: 'same' },
      { agent: 'a:b', sessionId: 'c' },
      { agent: 'a', sessionId: 'b:c' },
    ];
    const state = sessions.reduce(upsertStoredSession, emptyAgentPanelState());

    assert.equal(state.sessions.length, sessions.length);
  });

  it('builds a compact title from the first user prompt', () => {
    assert.equal(sessionTitleFromPrompt('  Fix\n\n  the   panel  '), 'Fix the panel');
    assert.equal(sessionTitleFromPrompt('一二三四', 3), '一二三…');
    assert.equal(sessionTitleFromPrompt('   '), '');
  });

  it('never persists an in-memory draft session', async () => {
    const storage = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: async (key) => ({ [key]: storage[key] }),
          set: async (patch) => Object.assign(storage, patch),
        },
      },
    };

    await updateAgentPanelState((state) => upsertStoredSession(state, { agent: 'claude', title: '', draft: true }));

    assert.deepEqual((await readAgentPanelState()).sessions, []);
  });

  it('persists sessions and per-agent defaults together', async () => {
    const storage = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: async (key) => ({ [key]: storage[key] }),
          set: async (patch) => Object.assign(storage, patch),
        },
      },
    };

    await updateAgentPanelState((state) =>
      upsertStoredSession(state, { agent: 'claude', sessionId: 'one', title: 'First' }),
    );
    await updateAgentPanelState((state) => ({
      ...state,
      defaults: {
        agent: 'claude',
        configOptionsByAgent: {
          claude: [{ id: 'mode', type: 'select', currentValue: 'plan', options: [] }],
          codex: [{ id: 'mode', type: 'select', currentValue: 'default', options: [] }],
        },
      },
    }));

    const state = await readAgentPanelState();
    assert.equal(state.sessions[0].title, 'First');
    assert.equal(state.defaults.configOptionsByAgent.claude[0].currentValue, 'plan');
    assert.equal(state.defaults.configOptionsByAgent.codex[0].currentValue, 'default');
  });
});
