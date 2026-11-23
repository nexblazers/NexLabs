import { SF } from './lib/sf.js';
import { Scanner, planOrder, defaultAction } from './lib/engine.js';
import { typeInfo, linksFor, OTHER_PACKAGE_TIP, DESTRUCTIVE_TYPES, DIRECT_DELETE, APEX_TYPES, objectFromFullName } from './lib/types.js';
import { destructiveZip, destructiveXml, toBase64 } from './lib/zip.js';
import { htmlEsc as h, to18, toCSV, sleep, soqlStr } from './lib/util.js';

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);

const S = {
  origin: params.get('origin'),
  sf: null, scanner: null, org: null, isProd: false, orgId: '',
  mode: 'managed', ns: '', pkgLabel: '', pkgId: '', pkgName: '',
  targets: [], level1Rows: [], textRows: [],
  nodes: new Map(), plan: [],
  overrides: {}, done: {}, prevIds: null, newIds: new Set(),
  busy: false
};

// ---------------- logging / UI helpers ----------------
function log(msg, level = 'info') {
  const el = $('#log');
  const t = new Date().toLocaleTimeString();
  el.textContent += `[${t}] ${level === 'warn' ? '⚠ ' : level === 'error' ? '✖ ' : ''}${msg}\n`;
  el.scrollTop = el.scrollHeight;
  if (level !== 'warn') setStatus(msg, S.busy);
}
function setStatus(msg, busy = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('busy', busy);
}
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', err);
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), err ? 7000 : 3500);
}
function modal(title, bodyHtml, actions) {
  return new Promise(resolve => {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    const box = $('#modalActions');
    box.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.cls) b.className = a.cls;
      b.onclick = () => { if (!a.keepOpen) $('#modal').classList.add('hidden'); resolve(a.value); };
      box.appendChild(b);
    }
    $('#modal').classList.remove('hidden');
  });
}
const closeModal = () => $('#modal').classList.add('hidden');

// ---------------- session ----------------
async function getSession(origin) {
  const first = await chrome.cookies.get({ url: origin, name: 'sid' });
  if (!first) throw new Error(`No Salesforce session found for ${origin}. Log in to the org in this browser, then reopen.`);
  const orgId = first.value.split('!')[0];
  let cands = [];
  for (const domain of ['salesforce.com', 'cloudforce.com', 'salesforce.mil']) {
    try { cands.push(...await chrome.cookies.getAll({ name: 'sid', domain, secure: true })); } catch (e) { /* ignore */ }
  }
  cands = cands.filter(c => c.value.startsWith(orgId + '!') && !/^\.?(login|test)\./i.test(c.domain));
  cands.sort((a, b) => (b.domain.includes('.my.') ? 1 : 0) - (a.domain.includes('.my.') ? 1 : 0));
  const best = cands[0];
  if (!best) {
    const host = new URL(origin).hostname;
    if (/\.my\.salesforce\.com$/i.test(host)) return { host, sid: first.value, orgId };
    throw new Error('Found a Lightning session but not an API session. Open any Setup page on the org (my.salesforce.com) once, then reopen.');
  }
  return { host: best.domain.replace(/^\./, ''), sid: best.value, orgId };
}

// ---------------- storage (per org + scope) ----------------
const scopeKey = () => `pbf:${S.orgId}:${S.mode}:${S.mode === 'managed' ? S.ns.toLowerCase() : S.mode === 'unmanaged' ? S.pkgName : 'custom'}`;
async function loadState() {
  const k = scopeKey();
  const v = (await chrome.storage.local.get(k))[k] || {};
  S.overrides = v.overrides || {};
  S.done = v.done || {};
  S.prevIds = v.ids ? new Set(v.ids) : null;
}
async function saveState() {
  const k = scopeKey();
  await chrome.storage.local.set({ [k]: { overrides: S.overrides, done: S.done, ids: [...S.nodes.keys()], at: Date.now() } });
}

// ---------------- init ----------------
async function init() {
  if (!S.origin) { setStatus('Open this page from the extension button on a Salesforce tab.'); return; }
  try {
    setStatus('Connecting…', true);
    const sess = await getSession(S.origin);
    S.orgId = sess.orgId;
    S.sf = new SF({ host: sess.host, sid: sess.sid });
    await S.sf.detectVersion();
    const [org] = await S.sf.query('SELECT Id, Name, IsSandbox, OrganizationType FROM Organization');
    S.org = org;
    S.isProd = !org.IsSandbox && org.OrganizationType !== 'Developer Edition';
    $('#orgInfo').innerHTML = `${h(org.Name)} · ${h(sess.host)} · <b>${org.IsSandbox ? 'Sandbox' : S.isProd ? 'PRODUCTION' : h(org.OrganizationType)}</b> · API v${h(S.sf.version)}`;
    await loadPackages();
    $('#scanBtn').disabled = false;
    setStatus('Ready.');
    if (params.get('ns')) { $('#nsInput').value = params.get('ns'); }
  } catch (e) {
    setStatus(e.message);
    log(e.message, 'error');
    $('#orgInfo').textContent = 'Not connected';
  }
}

async function loadPackages() {
  const sel = $('#pkgSelect');
  try {
    const pk = await S.sf.tooling('SELECT Id, SubscriberPackageId, SubscriberPackage.Name, SubscriberPackage.NamespacePrefix, SubscriberPackageVersion.Name, SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion FROM InstalledSubscriberPackage');
    pk.sort((a, b) => (a.SubscriberPackage?.Name || '').localeCompare(b.SubscriberPackage?.Name || ''));
    sel.innerHTML = '<option value="">— choose a package —</option>' + pk.map(p => {
      const ns = p.SubscriberPackage?.NamespacePrefix || '';
      const v = p.SubscriberPackageVersion ? ` ${p.SubscriberPackageVersion.MajorVersion}.${p.SubscriberPackageVersion.MinorVersion}` : '';
      return `<option value="${h(ns)}" data-id="${h(p.SubscriberPackageId)}" data-name="${h(p.SubscriberPackage?.Name)}" ${ns ? '' : 'disabled'}>${h(p.SubscriberPackage?.Name)}${h(v)} ${ns ? `(${h(ns)})` : '(no namespace — use Unmanaged mode)'}</option>`;
    }).join('');
  } catch (e) {
    sel.innerHTML = '<option value="">Could not list packages — type the namespace</option>';
    log(`Installed packages: ${e.message}`, 'warn');
  }
  sel.onchange = () => { $('#nsInput').value = sel.value; };
  try {
    const mp = await S.sf.tooling('SELECT Id, Name FROM MetadataPackage');
    $('#pkgNames').innerHTML = mp.map(p => `<option value="${h(p.Name)}">`).join('');
  } catch (e) { /* not available in every org */ }
}

// ---------------- scanning ----------------
const actionOf = n => S.overrides[n.id] || defaultAction(n, { mode: S.mode, ns: S.ns });

async function scan({ fresh = true } = {}) {
  if (S.busy) return;
  S.busy = true;
  $('#scanBtn').disabled = true;
  $('#rescanBtn').disabled = true;
  const t0 = Date.now();
  const callsBefore = S.sf.calls;
  try {
    readScope();
    await loadState();
    if (fresh || !S.scanner) S.scanner = new Scanner(S.sf, log);
    const sc = S.scanner;
    sc.bulkAll = $('#optBulk').checked;
    S.targets = []; S.textRows = []; S.level1Rows = []; S.analyticsRows = [];

    if (S.mode === 'managed') {
      if (!S.ns) throw new Error('Choose a package or type its namespace.');
      log(`Scanning everything outside "${S.ns}" that references it…`);
      S.level1Rows = await sc.managedLevel1(S.ns, { bulk: $('#optBulk').checked });
      log(`Dependency API: ${S.level1Rows.length} direct reference(s).`);
      if ($('#optText').checked) S.textRows = await sc.textScan(S.ns, { listViews: $('#optListViews').checked });
    } else if (S.mode === 'unmanaged') {
      if (!S.pkgName) throw new Error('Type the unmanaged package name.');
      log(`Retrieving members of package "${S.pkgName}" (Metadata API)…`);
      const files = await S.sf.retrievePackageMembers(S.pkgName, s => log(`  retrieve: ${s}`));
      S.targets = files
        .filter(f => f.id && f.type && f.type !== 'Package' && !f.namespacePrefix)
        .filter(f => f.type !== 'CustomObject' || /__[a-z]+$/i.test(f.fullName)) // skip standard objects
        .map(f => ({ id: to18(f.id), type: f.type, name: f.fullName, fullName: f.fullName, objectName: objectFromFullName(f.type, f.fullName) }));
      if (!S.targets.length) throw new Error(`No components found in package "${S.pkgName}". Check the exact name.`);
      log(`Package has ${S.targets.length} component(s). Finding what references them…`);
      S.level1Rows = await sc.referrersOf(S.targets.map(t => t.id));
    } else {
      const ids = $('#idsInput').value.split(/[\s,;]+/).map(s => s.trim()).filter(s => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(s)).map(to18);
      if (!ids.length) throw new Error('Paste at least one 15- or 18-character component Id.');
      log(`Finding what references ${ids.length} component(s)…`);
      S.level1Rows = await sc.referrersOf(ids);
      S.targets = ids.map(id => {
        const r = S.level1Rows.find(x => x.RefMetadataComponentId === id);
        return { id, type: r ? r.RefMetadataComponentType : 'Component', name: r ? r.RefMetadataComponentName : id };
      });
    }
    await rebuild();
    // diff with previous scan
    S.newIds = new Set();
    if (S.prevIds) {
      for (const id of S.nodes.keys()) if (!S.prevIds.has(id)) S.newIds.add(id);
      const resolved = [...S.prevIds].filter(id => !S.nodes.has(id)).length;
      if (S.prevIds.size) toast(`Re-scan: ${resolved} resolved, ${S.newIds.size} new blocker(s).`);
    }
    await saveState();
    render();
    log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${S.nodes.size} component(s) in plan · ${S.sf.calls - callsBefore} API calls.`);
  } catch (e) {
    log(e.message, 'error');
    toast(e.message, true);
  } finally {
    S.busy = false;
    setStatus($('#status').textContent, false);
    $('#scanBtn').disabled = false;
    $('#rescanBtn').disabled = false;
  }
}

async function rebuild() {
  const sc = S.scanner;
  sc.warnings = sc.warnings.filter(w => !w.startsWith('Stopped at depth'));
  const base = { targets: S.targets, level1Rows: S.level1Rows, actionOf, maxDepth: Math.max(1, +$('#optDepth').value || 8) };
  const reports = $('#optReports').checked, reportTypes = $('#optReportTypes').checked;
  const sig = rows => rows.map(r => `${r.id}:${[...r.refs].sort().join(',')}:${r.suggested || ''}`).sort().join('|');
  let extra = S.analyticsRows || [];
  let nodes;
  // Reports/report types/dashboards depend on what's being deleted, and can add deletes themselves,
  // so alternate build <-> analytics scan until the plan stops changing.
  for (let pass = 0; pass < 5; pass++) {
    nodes = await sc.build({ ...base, textRows: [...S.textRows, ...extra] });
    if (!reports && !reportTypes) { extra = []; break; }
    await sc.enrich(nodes);
    const next = await sc.analyticsRows(nodes, { ns: S.mode === 'managed' ? S.ns : null, actionOf, reports, reportTypes,
                                                 reportCap: Math.max(100, +$('#optReportCap').value || 3000),
                                                 reportScope: $('#optReportScope').value, childReports: $('#optChildReports').checked });
    if (sig(next) === sig(extra)) break;
    extra = next;
  }
  S.analyticsRows = extra;
  S.nodes = nodes;
  log(`Resolving names and links for ${S.nodes.size} component(s)…`);
  await sc.enrich(S.nodes);
  S.plan = planOrder(S.nodes, actionOf);
}

function readScope() {
  S.ns = $('#nsInput').value.trim().replace(/__$/, '');
  const opt = $('#pkgSelect').selectedOptions[0];
  S.pkgLabel = opt && opt.value === S.ns ? opt.dataset.name : S.ns;
  S.pkgId = opt && opt.value === S.ns ? opt.dataset.id : '';
  S.pkgName = $('#pkgName').value.trim();
}

// ---------------- rendering ----------------
function render() {
  $('#results').classList.remove('hidden');
  const nodes = [...S.nodes.values()].filter(n => n.role !== 'target' || S.mode !== 'managed');
  const count = a => nodes.filter(n => actionOf(n) === a).length;
  const doneN = nodes.filter(n => S.done[n.id]).length;
  const depth = nodes.reduce((m, n) => Math.max(m, n.level), 0);
  const cycles = S.plan.filter(g => g.cycle).length;
  $('#summary').innerHTML = [
    ['Components in plan', nodes.length, ''],
    ['To delete', count('delete'), 'del'],
    ['To modify', count('modify'), 'mod'],
    ['Other packages', count('other-package'), 'oth'],
    ['Chain depth', depth, ''],
    ['Circular groups', cycles, cycles ? 'oth' : ''],
    ['Done', `${doneN}/${nodes.length}`, 'ok']
  ].map(([k, v, c]) => `<div class="stat ${c}"><div class="v">${h(v)}</div><div class="k">${h(k)}</div></div>`).join('');

  const notes = (S.scanner && S.scanner.notes) || [];
  $('#notes').classList.toggle('hidden', !notes.length);
  $('#notes').innerHTML = notes.map(n => `<div>ℹ ${h(n)}</div>`).join('');
  const warns = S.scanner ? [...new Set(S.scanner.warnings)] : [];
  $('#warnings').classList.toggle('hidden', !warns.length);
  $('#warnings').innerHTML = warns.length ? `<b>Heads up</b><ul>${warns.map(w => `<li>${h(w)}</li>`).join('')}</ul>` : '';

  const filter = $('#filter').value.trim().toLowerCase();
  const af = $('#actionFilter').value;
  const hideDone = $('#hideDone').checked;
  const base = `https://${S.sf.host}`;
  const tbody = $('#plan tbody');
  const rows = [];
  let i = 0;

  if (!S.plan.length) {
    rows.push(`<tr><td colspan="9" class="empty">✓ No blockers found${S.mode === 'managed' ? ` for ${h(S.ns)}` : ''}. Try the uninstall now${S.mode === 'managed' ? ' (or enable Bulk deep scan / text scan to double-check)' : ''}.</td></tr>`);
  }

  for (const g of S.plan) {
    g.ids.forEach((id, gi) => {
      const n = S.nodes.get(id);
      i++;
      const act = actionOf(n);
      const text = `${n.name} ${n.fullName || ''} ${n.type}`.toLowerCase();
      if (filter && !text.includes(filter)) return;
      if (af && act !== af) return;
      if (hideDone && S.done[id]) return;
      rows.push(rowHtml(n, i, act, g, gi, base));
    });
  }

  if (S.plan.length || S.mode === 'managed') {
    if (S.mode === 'managed') {
      const url = S.pkgId ? `${base}/lightning/setup/ImportedPackage/page?address=${encodeURIComponent('/' + S.pkgId)}` : `${base}/lightning/setup/ImportedPackage/home`;
      rows.push(`<tr class="final"><td></td><td>${i + 1}</td><td><span class="lvl l0">L0</span></td><td class="type">Package</td><td><div class="name">${h(S.pkgLabel || S.ns)}</div></td><td></td><td>Uninstall</td><td class="tip">When every row above is done, uninstall the package. If it still fails, click ↻ Re-scan — new blockers are marked NEW.</td><td><div class="links"><a href="${h(url)}" target="_blank">Uninstall ↗</a></div></td></tr>`);
    } else if (S.mode === 'unmanaged') {
      rows.push(`<tr class="final"><td></td><td>${i + 1}</td><td><span class="lvl l0">—</span></td><td class="type">Package</td><td><div class="name">${h(S.pkgName)}</div></td><td></td><td>Delete container</td><td class="tip">After its components are deleted, remove the empty package container.</td><td><div class="links"><a href="${h(base)}/lightning/setup/Package/home" target="_blank">Packages ↗</a></div></td></tr>`);
    }
  }
  tbody.innerHTML = rows.join('');
}

function rowHtml(n, i, act, g, gi, base) {
  const isTarget = n.role === 'target';
  const info = typeInfo(n.type);
  let tip = act === 'other-package' ? OTHER_PACKAGE_TIP(n.ns) : info.tip;
  if (isTarget && S.mode !== 'managed') tip = `Component being removed. ${info.action === 'delete' ? info.tip : 'Delete it once everything above is fixed.'}`;
  if (act === 'modify' && info.action === 'delete') tip = 'Edit this component to remove its reference to the item(s) listed, then save.';
  const DELETE_TIPS = {
    Report: 'Delete the report (export it first if anyone still needs the data). Dashboards on it are listed above.',
    Dashboard: 'Delete the dashboard.',
    ReportType: 'Delete the custom report type after the reports built on it (listed above) are deleted.'
  };
  if (act === 'delete' && DELETE_TIPS[n.type]) tip = DELETE_TIPS[n.type];
  if (n.sources.has('text') && !n.sources.has('dependency')) tip += ' (Found by text scan — confirm it\'s a real reference, not a comment or string.)';
  if (g.cycle) tip = `Circular reference group — delete these together in one deploy. ${tip}`;
  if (n.type === 'Flow' && n.status) tip += ` This is v${n.version} (${n.status}).`;
  if (n.reason) tip = `${n.reason} ${tip}`;
  if ((n.type === 'Report' || n.type === 'Dashboard') && n.privateFolder && act === 'delete') tip += ' It\'s in a private folder, so it can\'t go in the destructive deploy — use Delete now.';
  if (APEX_TYPES.has(n.type) && S.isProd && act === 'delete') tip += ' Production: use the destructive deploy.';

  const badges = [
    S.newIds.has(n.id) ? '<span class="badge new">NEW</span>' : '',
    n.sources.has('text') ? '<span class="badge text">text match</span>' : '',
    n.sources.has('analytics') ? '<span class="badge rep">report scan</span>' : '',
    g.cycle && gi === 0 ? '<span class="badge cyc">cycle</span>' : ''
  ].join('');

  const refs = [...n.refLabels];
  const refsHtml = refs.slice(0, 3).map(r => `<div title="${h(r)}">→ ${h(r)}</div>`).join('') + (refs.length > 3 ? `<div>+${refs.length - 3} more</div>` : '');

  let actHtml;
  if (isTarget) actHtml = '<span class="act-fixed delete">Delete</span>';
  else if (act === 'other-package') actHtml = `<span class="act-fixed other-package">Uninstall ${h(n.ns)} first</span>`;
  else actHtml = `<select class="act ${act}" data-id="${h(n.id)}"><option value="delete" ${act === 'delete' ? 'selected' : ''}>Delete</option><option value="modify" ${act === 'modify' ? 'selected' : ''}>Modify</option></select>`;

  const links = linksFor(base, n).map(l => `<a href="${h(l.url)}" target="_blank" rel="noopener">${h(l.label)} ↗</a>`);
  const canDelete = (act === 'delete' || isTarget) && DIRECT_DELETE.has(n.type) && !(APEX_TYPES.has(n.type) && S.isProd);
  if (canDelete && !S.done[n.id]) links.push(`<button class="small danger" data-del="${h(n.id)}">Delete now</button>`);

  const cls = [S.done[n.id] ? 'done' : '', g.cycle ? 'cycle' : '', g.cycle && gi === 0 ? 'cycle-start' : ''].join(' ');
  return `<tr class="${cls}">
    <td><input type="checkbox" data-done="${h(n.id)}" ${S.done[n.id] ? 'checked' : ''}></td>
    <td>${i}</td>
    <td><span class="lvl ${n.level === 0 ? 'l0' : ''}">L${n.level}</span></td>
    <td class="type">${h(n.type)}</td>
    <td><div class="name">${h(n.name || n.id)}${badges}</div>${n.fullName && n.fullName !== n.name ? `<div class="full">${h(n.fullName)}</div>` : ''}<div class="full">${h(n.id)}</div></td>
    <td class="refs">${refsHtml}</td>
    <td>${actHtml}</td>
    <td class="tip">${h(tip)}</td>
    <td><div class="links">${links.join('')}</div></td>
  </tr>`;
}

// ---------------- row actions ----------------
$('#plan').addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.done) {
    if (t.checked) S.done[t.dataset.done] = Date.now(); else delete S.done[t.dataset.done];
    await saveState();
    render();
  } else if (t.classList.contains('act')) {
    const n = S.nodes.get(t.dataset.id);
    const def = defaultAction(n, { mode: S.mode, ns: S.ns });
    if (t.value === def) delete S.overrides[n.id]; else S.overrides[n.id] = t.value;
    S.busy = true; setStatus('Updating the chain…', true);
    try { await rebuild(); await saveState(); render(); setStatus(`Updated · ${S.nodes.size} component(s) in plan.`); }
    catch (err) { toast(err.message, true); }
    finally { S.busy = false; }
  }
});

$('#plan').addEventListener('click', async e => {
  const id = e.target.dataset && e.target.dataset.del;
  if (!id) return;
  const n = S.nodes.get(id);
  const extra = n.type === 'Flow' ? '<p>This deactivates the flow and deletes <b>all of its versions</b>.</p>'
    : n.type === 'CustomField' ? '<p>The field moves to "Deleted Fields" (kept 15 days). If the uninstall still complains, erase it there.</p>' : '';
  const ok = await modal(`Delete ${n.type} "${n.name}"?`,
    `<p>This deletes the component in <b>${h(S.org.Name)}</b>${S.isProd ? ' (<b>PRODUCTION</b>)' : ''} right now, using your permissions.</p>${extra}<p>Make sure nothing listed above it in the plan still references it.</p>`,
    [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, cls: 'danger' }]);
  if (!ok) return;
  try {
    e.target.disabled = true;
    await deleteNow(n);
    S.done[n.id] = Date.now();
    await saveState();
    toast(`Deleted ${n.name}. Re-scan when you've done a batch.`);
    log(`Deleted ${n.type} ${n.name}`);
    render();
  } catch (err) {
    e.target.disabled = false;
    toast(`Couldn't delete ${n.name}: ${err.message}`, true);
    log(`Delete failed for ${n.name}: ${err.message}`, 'error');
  }
});

async function deleteNow(n) {
  const sf = S.sf;
  if (n.type === 'Flow') {
    let defId = n.definitionId || (n.id.startsWith('300') ? n.id : null);
    if (!defId) defId = (await sf.tooling(`SELECT DefinitionId FROM Flow WHERE Id = '${soqlStr(n.id)}'`))[0]?.DefinitionId;
    if (!defId) throw new Error('Flow definition not found');
    const def = (await sf.tooling(`SELECT Id, ActiveVersionId FROM FlowDefinition WHERE Id = '${soqlStr(defId)}'`))[0];
    if (def && def.ActiveVersionId) await sf.patchTooling('FlowDefinition', defId, { Metadata: { activeVersionNumber: 0 } });
    const versions = await sf.tooling(`SELECT Id FROM Flow WHERE DefinitionId = '${soqlStr(defId)}'`);
    for (const v of versions) await sf.deleteTooling('Flow', v.Id);
    // mark sibling version rows as done too
    for (const other of S.nodes.values()) if (other.type === 'Flow' && other.definitionId === defId) S.done[other.id] = Date.now();
    return;
  }
  if (n.type === 'Report') return sf.req(`${sf.dataPath}/analytics/reports/${n.id}`, { method: 'DELETE' });
  if (n.type === 'Dashboard') return sf.req(`${sf.dataPath}/analytics/dashboards/${n.id}`, { method: 'DELETE' });
  return sf.deleteTooling(n.type, n.id);
}

// ---------------- destructive deploy ----------------
function deleteItems() {
  const items = [], skipped = [], seen = new Set();
  for (const g of S.plan) for (const id of g.ids) {
    const n = S.nodes.get(id);
    if (actionOf(n) !== 'delete' || S.done[id]) continue;
    const key = `${n.type}:${n.fullName}`;
    if (DESTRUCTIVE_TYPES.has(n.type) && n.fullName) {
      if (!seen.has(key)) { seen.add(key); items.push({ type: n.type, fullName: n.fullName }); }
    } else skipped.push(n);
  }
  return { items, skipped };
}

$('#zipBtn').addEventListener('click', () => {
  const { items, skipped } = deleteItems();
  if (!items.length) return toast('No Delete rows can go in a destructive deploy.', true);
  const zip = destructiveZip(items, S.sf.version);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
  a.download = `nexblazers-destructive-${(S.ns || S.pkgName || 'components').replace(/\W+/g, '_')}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Downloaded ${items.length} component(s).${skipped.length ? ` ${skipped.length} need manual delete (see table).` : ''} Deploy with: sf project deploy start --metadata-dir <unzipped folder> --target-org <org>`);
});

$('#deployBtn').addEventListener('click', async () => {
  const { items, skipped } = deleteItems();
  if (!items.length) return toast('No Delete rows can go in a destructive deploy.', true);
  const testLevel = S.isProd ? 'RunLocalTests' : 'NoTestRun';
  const body = `<p>This deletes <b>${items.length}</b> component(s) from <b>${h(S.org.Name)}</b>${S.isProd ? ' (<b>PRODUCTION</b>)' : ''} in one deployment. If anything fails, nothing is deleted (rollback on error).</p>
    <p>Tests: <b>${testLevel}</b>${S.isProd ? '' : ' · purge on delete (fields skip the recycle bin)'}.</p>
    ${modifyPending() ? `<p style="color:#b42318"><b>${modifyPending()} Modify row(s) are not done yet.</b> Those references will make the deploy fail until they're fixed.</p>` : ''}
    ${skipped.length ? `<p>${skipped.length} Delete row(s) can't be included (no metadata name, or type not deployable): ${skipped.slice(0, 8).map(n => h(n.name)).join(', ')}${skipped.length > 8 ? '…' : ''}</p>` : ''}
    <details><summary>destructiveChanges.xml</summary><pre>${h(destructiveXml(items, S.sf.version))}</pre></details>`;
  const choice = await modal('Deploy all deletes', body, [
    { label: 'Cancel', value: null },
    { label: 'Validate only', value: 'validate' },
    { label: 'Deploy', value: 'deploy', cls: 'danger' }
  ]);
  if (!choice) return;
  await runDeploy(items, choice === 'validate', testLevel);
});

const modifyPending = () => [...S.nodes.values()].filter(n => actionOf(n) === 'modify' && !S.done[n.id]).length;

async function runDeploy(items, checkOnly, testLevel) {
  const zip = destructiveZip(items, S.sf.version);
  const show = (html, done = false) => {
    $('#modalTitle').textContent = checkOnly ? 'Validating…' : 'Deploying…';
    $('#modalBody').innerHTML = html;
    $('#modalActions').innerHTML = done ? '<button id="mClose">Close</button>' : '';
    if (done) $('#mClose').onclick = closeModal;
    $('#modal').classList.remove('hidden');
  };
  try {
    show('<p class="status busy">Starting deployment…</p>');
    const id = await S.sf.deploy(toBase64(zip), { checkOnly, testLevel, purgeOnDelete: !S.isProd });
    log(`${checkOnly ? 'Validation' : 'Deployment'} started: ${id}`);
    let st;
    for (let k = 0; k < 400; k++) {
      await sleep(3000);
      st = await S.sf.checkDeploy(id);
      show(`<p class="status busy">${h(st.status)} · ${h(st.componentsDeployed || 0)}/${h(st.componentsTotal || '?')} components</p>`);
      if (st.done) break;
    }
    const link = `https://${S.sf.host}/lightning/setup/DeployStatus/page?address=${encodeURIComponent('/changemgmt/monitorDeploymentsDetails.apexp?asyncId=' + id)}`;
    if (st && st.success) {
      $('#modalTitle').textContent = checkOnly ? 'Validation passed ✓' : 'Deployed ✓';
      if (!checkOnly) {
        for (const g of S.plan) for (const nid of g.ids) {
          const n = S.nodes.get(nid);
          if (items.some(it => it.type === n.type && it.fullName === n.fullName)) S.done[nid] = Date.now();
        }
        await saveState();
        render();
      }
      show(`<p>${checkOnly ? 'Everything can be deleted. Run Deploy to do it for real.' : `${items.length} component(s) deleted. Click ↻ Re-scan, then try the uninstall.`}</p><p><a href="${h(link)}" target="_blank">Deployment status ↗</a></p>`, true);
      $('#modalTitle').textContent = checkOnly ? 'Validation passed ✓' : 'Deployed ✓';
    } else {
      $('#modalTitle').textContent = 'Deployment failed';
      const f = (st && st.failures) || [];
      show(`<p>${h(st ? st.errorMessage || st.status : 'Timed out')}</p>${f.length ? `<ul>${f.slice(0, 40).map(x => `<li><b>${h(x.type)} ${h(x.name)}</b>: ${h(x.problem)}</li>`).join('')}</ul>` : ''}
        <p>Usually this means something still references a component. Fix the named items (or switch them to Delete), Re-scan, and try again.</p><p><a href="${h(link)}" target="_blank">Deployment status ↗</a></p>`, true);
      $('#modalTitle').textContent = 'Deployment failed';
    }
  } catch (e) {
    show(`<p>${h(e.message)}</p>`, true);
    $('#modalTitle').textContent = 'Deployment error';
  }
}

// ---------------- export ----------------
$('#csvBtn').addEventListener('click', () => {
  const base = `https://${S.sf.host}`;
  const out = [['Order', 'Level', 'Type', 'Name', 'Full name', 'Id', 'Action', 'References', 'What to do', 'Link', 'Circular group', 'Done']];
  let i = 0;
  for (const g of S.plan) for (const id of g.ids) {
    const n = S.nodes.get(id);
    const act = actionOf(n);
    out.push([++i, n.level, n.type, n.name, n.fullName || '', n.id, act, [...n.refLabels].join(' | '),
      act === 'other-package' ? OTHER_PACKAGE_TIP(n.ns) : typeInfo(n.type).tip, linksFor(base, n)[0].url, g.cycle ? 'yes' : '', S.done[id] ? 'yes' : '']);
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + toCSV(out)], { type: 'text/csv' }));
  a.download = `nexblazers-blockers-${(S.ns || S.pkgName || 'components').replace(/\W+/g, '_')}.csv`;
  a.click();
});
$('#printBtn').addEventListener('click', () => window.print());

// ---------------- wiring ----------------
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => {
  S.mode = b.dataset.mode;
  document.querySelectorAll('.mode').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== S.mode));
  document.querySelectorAll('[data-only]').forEach(el => el.classList.toggle('hidden', el.dataset.only !== S.mode));
}));
const syncReportOpts = () => {
  const on = $('#optReports').checked, all = $('#optReportScope').value === 'all';
  $('#capWrap').classList.toggle('hidden', !on || !all);
  $('#childWrap').classList.toggle('hidden', !on || all);
  $('#optReportScope').disabled = !on;
};
['#optReports', '#optReportScope'].forEach(sel => $(sel).addEventListener('change', syncReportOpts));
syncReportOpts();
$('#scanBtn').addEventListener('click', () => scan({ fresh: true }));
$('#rescanBtn').addEventListener('click', () => scan({ fresh: true }));
['#filter', '#actionFilter', '#hideDone'].forEach(s => $(s).addEventListener('input', () => S.plan && render()));

init();
