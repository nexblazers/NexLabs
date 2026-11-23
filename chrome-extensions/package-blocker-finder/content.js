// Adds a floating "Find all blockers" button on Salesforce package setup pages.
(() => {
  const PAGE_RE = /ImportedPackage|InstalledPackage|PackageUninstall|uninstall|\/Package\/|\/0A3|\/033/i;
  let btn = null;

  function ensureButton() {
    const show = PAGE_RE.test(location.href);
    if (show && !btn) {
      btn = document.createElement('button');
      const icon = document.createElement('img');
      icon.src = chrome.runtime.getURL('icons/icon32.png');
      Object.assign(icon.style, { width: '22px', height: '22px', borderRadius: '6px' });
      const label = document.createElement('span');
      label.innerHTML = 'Find all blockers<br><span style="font-size:10px;font-weight:600;opacity:.85;letter-spacing:.08em">BY NEXBLAZERS</span>';
      label.style.textAlign = 'left';
      label.style.lineHeight = '1.15';
      btn.append(icon, label);
      btn.title = 'Package Blocker Finder by NexBlazers: list every component blocking this uninstall, in fix order';
      Object.assign(btn.style, {
        position: 'fixed', right: '20px', bottom: '20px', zIndex: 2147483647,
        display: 'flex', alignItems: 'center', gap: '8px',
        background: 'linear-gradient(90deg, #0b2a5b, #0a5bd8)', color: '#fff', border: 'none', borderRadius: '14px',
        padding: '8px 14px 8px 8px', font: '700 13px system-ui, sans-serif', cursor: 'pointer',
        boxShadow: '0 4px 14px rgba(11,42,91,.35)'
      });
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'pbf-open', origin: location.origin });
      });
      document.body.appendChild(btn);
    } else if (!show && btn) {
      btn.remove();
      btn = null;
    }
  }

  ensureButton();
  // Lightning is a single-page app: watch for URL changes.
  let last = location.href;
  setInterval(() => {
    if (location.href !== last) { last = location.href; ensureButton(); }
  }, 1000);
})();
