// The tool keys keep their existing values so installed configurations remain
// intact. New keys use a feature prefix and schema suffix.
const keys = {
  toolsets: 'toolsets',
  toolStates: 'toolStates',
  likedToolsets: 'likedToolsets',
  agentPanelState: 'browser4agent.agentPanelState.v2',
  relayId: 'browser4agent.relayId.v1',
};

const values = Object.values(keys);
if (new Set(values).size !== values.length) throw new TypeError('Duplicate chrome.storage.local key');

export const localStorageKeys = Object.freeze(keys);
