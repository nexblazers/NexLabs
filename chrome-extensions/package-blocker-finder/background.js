// Opens the Blocker Finder page for the org the user is on.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'pbf-open' && msg.origin) {
    const url = chrome.runtime.getURL(`app.html?origin=${encodeURIComponent(msg.origin)}`
      + (msg.ns ? `&ns=${encodeURIComponent(msg.ns)}` : ''));
    chrome.tabs.create({ url, index: sender.tab ? sender.tab.index + 1 : undefined });
  }
});
