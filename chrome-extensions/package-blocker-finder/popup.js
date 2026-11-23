const SF_HOST = /(\.salesforce\.com|\.force\.com|\.salesforce-setup\.com|\.cloudforce\.com|\.salesforce\.mil)$/i;

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const btn = document.getElementById('open');
  let origin = null;
  try {
    const u = new URL(tab.url);
    if (SF_HOST.test(u.hostname)) origin = u.origin;
  } catch (e) { /* not a normal page */ }

  if (!origin) {
    document.getElementById('msg').textContent = 'Open a tab on your Salesforce org (logged in), then click the extension again.';
    return;
  }
  document.getElementById('org').textContent = origin;
  btn.disabled = false;
  btn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`app.html?origin=${encodeURIComponent(origin)}`) });
    window.close();
  });
});
