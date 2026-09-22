// The tool keys keep their existing values so installed configurations remain intact.
const keys = {
  toolsets: 'toolsets',
  toolStates: 'toolStates',
  likedToolsets: 'likedToolsets',
};

const values = Object.values(keys);
if (new Set(values).size !== values.length) throw new TypeError('Duplicate chrome.storage.local key');

export const localStorageKeys = Object.freeze(keys);
