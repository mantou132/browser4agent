import { devtoolsOpenTabs } from './shared/devtools-tracker.js';

// CDP debugging sessions behind the debugger_send_command / debugger_detach
// MCP tools. chrome.debugger pushes events while MCP pulls, so each tab keeps
// a ring buffer that execute_script_in_background exposes to agent scripts as
// the `debuggerEvents` global (see debuggerSnapshot). Attachments outlive
// service worker restarts, so the small per-tab state is persisted in
// storage.session and restored on wake; buffered events are not (they only
// exist while the worker lives).
const MAX_EVENTS = 2000;
const STORAGE_KEY = 'debuggerTabStates';

// tabId -> { attached, detachReason, buffer: [{method, params, time, seq}], cursor, dropped }
const tabStates = new Map();

let persistScheduled = false;

const hydrated = hydrate();
async function hydrate() {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  for (const [tabId, state] of Object.entries(stored[STORAGE_KEY] || {})) {
    tabStates.set(Number(tabId), { ...state, buffer: [], dropped: 0 });
  }
}

// Coalesced because recordEvent can fire hundreds of times in a burst.
function persistState() {
  if (persistScheduled) return;
  persistScheduled = true;
  setTimeout(async () => {
    persistScheduled = false;
    const states = {};
    for (const [tabId, { attached, detachReason, cursor }] of tabStates) {
      states[tabId] = { attached, detachReason, cursor };
    }
    await chrome.storage.session.set({ [STORAGE_KEY]: states });
  }, 100);
}

function recordEvent(tabId, method, params) {
  const state = tabStates.get(tabId);
  if (!state) return;
  state.buffer.push({ method, params, time: Date.now(), seq: state.cursor++ });
  if (state.buffer.length > MAX_EVENTS) {
    state.buffer.shift();
    state.dropped++;
  }
  persistState();
}

// Only fires for external terminations; debuggerDetach marks the state itself.
function markDetached(tabId, reason) {
  const state = tabStates.get(tabId);
  if (!state?.attached) return;
  state.attached = false;
  state.detachReason = reason || 'detached';
  persistState();
}

async function attach(tabId) {
  const state = tabStates.get(tabId);
  if (state?.attached) return;
  if (devtoolsOpenTabs.has(tabId)) {
    throw new Error(`DevTools is open on tab ${tabId}; close it before debugging it`);
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // Native errors like "Another debugger is already attached" or "No target
    // with given id found" are precise enough for agents to self-diagnose.
    throw new Error(e.message);
  }
  // Keep buffer and cursor across re-attach: agent scripts may still hold a
  // seq from the previous session, resetting either would hide events from them.
  tabStates.set(tabId, {
    attached: true,
    detachReason: null,
    buffer: state?.buffer ?? [],
    cursor: state?.cursor ?? 0,
    dropped: state?.dropped ?? 0,
  });
  persistState();
}

export async function debuggerSendCommand(tabId, method, params) {
  await hydrated;
  // Attaching is implicit: sessions start (and resume after the user dismissed
  // the banner) on the first command, only detaching stays explicit.
  await attach(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params ?? {});
  } catch (e) {
    // CDP errors (unknown method, bad params, session just gone) pass through verbatim
    throw new Error(e.message);
  }
}

export async function debuggerDetach(tabId) {
  await hydrated;
  const state = tabStates.get(tabId);
  if (!state?.attached) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) {
    // The session may have died between the check above and this call
    if (!/not attached|no target/i.test(e.message)) throw new Error(e.message);
  }
  state.attached = false;
  state.detachReason = 'detached';
  persistState();
}

// Plain-JSON snapshot of one tab handed to the execute_script_in_background
// sandbox as its `debuggerEvents` global; agent scripts filter it themselves.
export function debuggerSnapshot(tabId) {
  const s = tabStates.get(Number(tabId));
  if (!s) return null;
  return {
    attached: s.attached,
    cursor: s.cursor,
    events: s.buffer,
    ...(s.attached || !s.detachReason ? {} : { detachReason: s.detachReason }),
    ...(s.dropped ? { dropped: s.dropped } : {}),
  };
}

if (chrome.debugger) {
  chrome.debugger.onEvent.addListener((source, method, params) =>
    hydrated.then(() => recordEvent(source.tabId, method, params)),
  );
  chrome.debugger.onDetach.addListener((source, reason) => hydrated.then(() => markDetached(source.tabId, reason)));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  persistState();
});
