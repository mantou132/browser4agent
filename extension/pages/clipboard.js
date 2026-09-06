chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'clipboard') return;
  const input = document.querySelector('#clipboard');
  try {
    if (typeof message.text !== 'string') throw new TypeError('Clipboard text must be a string');
    input.value = message.text;
    input.select();
    // Offscreen documents cannot be focused, so navigator.clipboard is unavailable.
    if (!document.execCommand('copy')) throw new Error('Clipboard write failed');
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ error: error.message });
  } finally {
    input.value = '';
  }
});
