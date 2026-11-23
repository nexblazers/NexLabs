import { getSession, recordIdFromUrl } from './src/session.js';
import { SfApi } from './src/sfapi.js';
import { analyze } from './src/analyzer.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let api = null;
let me = null;
let srcUrl = null;

/** Tiny DOM builder. Everything is added as text nodes, so org data can never inject HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

const recordLink = (id, text) => el('a', { href: `https://${api.host}/${id}`, target: '_blank', rel: 'noopener' }, text ?? id);
const chip = (label, on) => el('span', { class: `chip ${on ? 'yes' : 'no'}` }, `${on ? '✓' : '✗'} ${label}`);

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

async function init() {
  if (params.has('src')) document.body.classList.add('tab');
  try {
    if (params.has('src')) {
      srcUrl = params.get('src');
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      srcUrl = tab?.url;
    }
    api = await new SfApi(await getSession(srcUrl)).init();
    me = await api.currentUser();
    $('context').textContent = `Org: ${api.host}` + (me ? ` · Checking as ${me.name} (${me.username})` : '') + ` · API v${api.version}`;

    const saved = await chrome.storage.local.get('lastUserId');
    $('userId').value = params.get('user') || saved.lastUserId || '';
    $('recordId').value = params.get('record') || recordIdFromUrl(srcUrl);
    $('check').disabled = false;
    if ($('userId').value && $('recordId').value && params.has('src')) run();
  } catch (e) {
    $('context').textContent = '';
    showError(e.message);
  }
}

async function run() {
  showError('');
  $('results').hidden = true;
  $('check').disabled = true;
  const userId = $('userId').value.trim();
  const recordId = $('recordId').value.trim();
  try {
    const result = await analyze(api, userId, recordId, (msg) => ($('status').textContent = msg));
    chrome.storage.local.set({ lastUserId: userId });
    render(result);
    $('status').textContent = '';
  } catch (e) {
    $('status').textContent = '';
    showError(e.errorCode === 'INVALID_SESSION_ID' ? 'Your Salesforce session has expired. Refresh the Salesforce tab and try again.' : e.message);
  } finally {
    $('check').disabled = false;
  }
}

function render(r) {
  const root = $('results');
  root.replaceChildren(
    renderVerdict(r),
    el('h2', {}, 'Record'),
    renderRecord(r),
    el('h2', {}, 'User'),
    renderUser(r),
    el('h2', {}, 'How the user gets access'),
    renderPaths(r),
    el('h2', {}, `Sharing on this record${r.shareObj ? ` (${r.shareObj})` : ''}`),
    renderShares(r),
    r.warnings.length ? [el('h2', {}, 'Notes & limitations'), el('ul', { class: 'warnings' }, r.warnings.map((w) => el('li', {}, w)))] : null
  );
  root.hidden = false;
}

function renderVerdict(r) {
  if (!r.ura) {
    return el('div', { class: 'verdict unknown' },
      el('strong', {}, 'Could not determine access'),
      el('span', {}, 'UserRecordAccess was not available to your login. See the access paths below.'));
  }
  const e = r.effective;
  const cls = e.read ? 'yes' : 'no';
  const headline = e.read
    ? `${r.user.Name} CAN access this record`
    : r.ura.HasReadAccess
      ? `${r.user.Name} has sharing access but CANNOT open this record`
      : `${r.user.Name} does NOT have access to this record`;
  return el('div', { class: `verdict ${cls}` },
    el('div', {},
      el('strong', {}, headline),
      el('div', { class: 'chips' },
        chip('Read', e.read), chip('Edit', e.edit), chip('Delete', e.delete),
        chip('Transfer', r.ura.HasTransferAccess), chip('Full access', r.ura.HasAllAccess)),
      r.ura.MaxAccessLevel ? el('div', { class: 'muted' }, `Max record access level (sharing): ${r.ura.MaxAccessLevel}`) : null));
}

function renderRecord(r) {
  const { record, owd } = r;
  return el('dl', {},
    el('dt', {}, 'Record'), el('dd', {}, recordLink(record.id, record.name ? `${record.name} (${record.id})` : record.id)),
    el('dt', {}, 'Object'), el('dd', {}, `${r.object.label} (${r.object.name})`),
    el('dt', {}, 'Owner'), el('dd', {}, record.owner ? [recordLink(record.owner.id, record.owner.name)] : 'Unknown'),
    owd ? [
      el('dt', {}, 'Org-wide default'),
      el('dd', {}, `Internal: ${owd.internalLabel} · External: ${owd.externalLabel} `,
        el('span', { class: 'muted' }, `(the ${owd.appliesTo} default applies to this user)`))
    ] : null,
    record.parent ? [
      el('dt', {}, 'Parent'),
      el('dd', {}, `${record.parent.object} via ${record.parent.field}: `, recordLink(record.parent.id), ' ',
        el('button', { class: 'link', type: 'button', onclick: () => { $('recordId').value = record.parent.id; run(); } }, 'Inspect parent'))
    ] : null);
}

function renderUser(r) {
  const u = r.user;
  const op = r.objPerms;
  const sp = r.systemPerms;
  return el('div', {},
    el('dl', {},
      el('dt', {}, 'User'), el('dd', {}, recordLink(u.Id, `${u.Name} (${u.Username})`), u.IsActive ? '' : ' — INACTIVE'),
      el('dt', {}, 'Type'), el('dd', {}, u.UserType),
      el('dt', {}, 'Profile'), el('dd', {}, u.Profile?.Name ?? '—'),
      el('dt', {}, 'Role'), el('dd', {}, u.UserRole?.Name ?? 'No role'),
      el('dt', {}, 'View All Data'), el('dd', {}, sp.viewAllData.length ? `Yes — ${sp.viewAllData.join(', ')}` : 'No'),
      el('dt', {}, 'Modify All Data'), el('dd', {}, sp.modifyAllData.length ? `Yes — ${sp.modifyAllData.join(', ')}` : 'No')),
    op
      ? [
          el('div', { class: 'chips' },
            chip('Read', op.read.granted), chip('Create', op.create.granted), chip('Edit', op.edit.granted),
            chip('Delete', op.delete.granted), chip('View All', op.viewAll.granted), chip('Modify All', op.modifyAll.granted)),
          el('table', {},
            el('thead', {}, el('tr', {}, el('th', {}, `${r.object.name} permission`), el('th', {}, 'Granted by'))),
            el('tbody', {},
              Object.entries({ Read: op.read, Create: op.create, Edit: op.edit, Delete: op.delete, 'View All': op.viewAll, 'Modify All': op.modifyAll })
                .map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, v.sources.length ? v.sources.join(', ') : '—')))))
        ]
      : el('p', { class: 'muted' }, 'Object-level permissions could not be determined.'));
}

function renderPaths(r) {
  if (!r.paths.length) {
    return el('p', {}, r.ura && !r.ura.HasReadAccess ? 'No sharing path grants this user access to the record.' : 'No access paths found.');
  }
  return el('ul', { class: 'paths' },
    r.paths.map((p) => el('li', {}, el('strong', {}, `${p.title} `), el('span', { class: 'chip' }, p.access), el('div', { class: 'muted' }, p.detail))));
}

function renderShares(r) {
  if (!r.shareObj) {
    return el('p', { class: 'muted' }, 'This object has no share table (sharing is public or controlled by a parent record).');
  }
  if (!r.shares.length) return el('p', { class: 'muted' }, 'No share records visible to you.');
  return el('table', {},
    el('thead', {}, el('tr', {}, ['Shared with', 'Access', 'Reason', 'Applies to user?'].map((h) => el('th', {}, h)))),
    el('tbody', {},
      r.shares.map((s) =>
        el('tr', { class: s.applies ? 'applies' : null },
          el('td', {}, s.sharedWith, el('div', { class: 'muted' }, el('code', {}, s.principalId))),
          el('td', {}, s.accessLevel,
            Object.keys(s.extra).length ? el('div', { class: 'muted' }, Object.entries(s.extra).map(([k, v]) => `${k}: ${v}`).join(', ')) : null),
          el('td', {}, s.rowCauseLabel),
          el('td', {}, s.applies ? `Yes — ${s.how}` : 'No')))));
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  run();
});
$('useMe').addEventListener('click', () => {
  if (me?.id) $('userId').value = me.id;
});
$('openTab').addEventListener('click', () => {
  const q = new URLSearchParams({ src: srcUrl ?? '', user: $('userId').value, record: $('recordId').value });
  chrome.tabs.create({ url: `${chrome.runtime.getURL('popup.html')}?${q}` });
});

init();
