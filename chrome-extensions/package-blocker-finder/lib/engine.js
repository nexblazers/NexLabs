// Blocker engine: finds the FULL chain of blockers and orders the fixes.
//
//  Level 1 = components outside the package that reference it.
//  For every component marked "delete", we also find what references *it* (level 2, 3, ...),
//  because Salesforce will block that delete too. "Modify" components stop the chain.
//  The result is ordered so every component is fixed before anything it references.
import { chunks, pool, soqlStr, escapeRe } from './util.js';
import { typeInfo, typeRank, objectFromFullName, TOOLING_SOBJECT } from './types.js';

const MCD_FIELDS = 'MetadataComponentId, MetadataComponentName, MetadataComponentNamespace, MetadataComponentType, '
  + 'RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentNamespace, RefMetadataComponentType';
const TOOLING_CAP = 2000;

// Objects whose children are too broad to expand (every object looks up to them).
const SKIP_CHILD_EXPANSION = new Set(['User', 'Group', 'Organization', 'RecordType', 'Profile', 'BusinessHours', 'UserRole']);

// Standard report type API names that don't start with the object name.
const RT_ALIAS = {
  Task: ['Activity', 'Task'], Event: ['Activity', 'Event'], Product2: ['Product', 'OpportunityProduct', 'PriceBook'],
  Pricebook2: ['PriceBook'], OpportunityLineItem: ['OpportunityProduct'], CampaignMember: ['Campaign'],
  OpportunityContactRole: ['Opportunity', 'ContactRole'], AccountContactRelation: ['Account', 'Contact']
};

// Custom report types appear as "Name__c" on reports but "Name" in metadata.
export const normRT = s => String(s || '').toLowerCase().replace(/__c$/, '');

// Does a report type (ReportTypeApiName) involve any of the objects?
export function reportTypeTouches(rt, objects, ns, crtNames = new Set()) {
  const r = String(rt || '').toLowerCase();
  if (!r) return true; // unknown type: read it to be safe
  if (ns && r.includes(`${ns.toLowerCase()}__`)) return true;
  if (crtNames.has(normRT(rt))) return true;
  for (const o of objects) {
    const l = o.toLowerCase();
    if (/__[a-z]+$/.test(l)) { if (r.includes(l)) return true; continue; }
    if (r === l || r.startsWith(l)) return true;
    for (const a of RT_ALIAS[o] || []) if (r.startsWith(a.toLowerCase())) return true;
  }
  return false;
}

export class Scanner {
  constructor(sf, log = () => {}) {
    this.sf = sf;
    this.log = log;
    this.cache = new Map();         // refId -> MCD rows referencing it
    this.inSupported = true;
    this.enriched = new Map();      // id -> {fullName, objectName, ...}
    this.badEnrichTypes = new Set();
    this.warnings = [];
    this.bulkAll = false;            // use Bulk API 2.0 for every level (includes reports)
    this.reports = null;             // [{id, name, ns, fullName, json}] cached report definitions
    this.reportTypes = null;         // [{id, fullName, ns, baseObject, xml}]
    this.dashByReport = new Map();   // reportId -> [{id, name, fullName, ns}]
  }

  warn(msg) { this.warnings.push(msg); this.log(msg, 'warn'); }
  note(msg) { this.notes = (this.notes || []).filter(n => n.split(':')[0] !== msg.split(':')[0]); this.notes.push(msg); this.log(msg); }

  // ---------- Seeds ----------

  // Everything outside namespace `ns` that references a component inside it.
  async managedLevel1(ns, { bulk = false } = {}) {
    const soql = `SELECT ${MCD_FIELDS} FROM MetadataComponentDependency WHERE RefMetadataComponentNamespace = '${soqlStr(ns)}'`;
    let rows = [];
    if (!bulk) {
      this.log('Querying Dependency API (Tooling)…');
      rows = await this.sf.tooling(soql);
      if (rows.length >= TOOLING_CAP) {
        this.warn('Tooling API hit its 2,000-row cap. Re-running with Bulk API 2.0 to get everything…');
        bulk = true;
      }
    }
    if (bulk) {
      this.log('Querying Dependency API (Bulk API 2.0, includes reports)…');
      rows = await this.sf.toolingBulk(soql, s => this.log(`  bulk job: ${s}`));
    }
    const lower = ns.toLowerCase();
    return rows.filter(r => (r.MetadataComponentNamespace || '').toLowerCase() !== lower);
  }

  // Rows for components that reference any of `ids` (cached).
  async referrersOf(ids) {
    const need = [...new Set(ids)].filter(id => !this.cache.has(id));
    for (const chunk of chunks(need, this.bulkAll ? 150 : 40)) {
      let rows = null;
      if (this.bulkAll) {
        try {
          rows = await this.sf.toolingBulk(`SELECT ${MCD_FIELDS} FROM MetadataComponentDependency WHERE RefMetadataComponentId IN (${chunk.map(i => `'${soqlStr(i)}'`).join(',')})`,
            st => this.log(`  bulk job: ${st}`));
        } catch (e) {
          this.warn(`Bulk API not available for deeper levels (${e.message}). Falling back to Tooling API — reports at deeper levels come from the report scan only.`);
          this.bulkAll = false;
        }
      }
      if (!rows && this.inSupported && chunk.length > 1) {
        try {
          rows = await this.sf.tooling(`SELECT ${MCD_FIELDS} FROM MetadataComponentDependency WHERE RefMetadataComponentId IN (${chunk.map(i => `'${soqlStr(i)}'`).join(',')})`);
          if (rows.length >= TOOLING_CAP) {
            this.warn('A batch hit the 2,000-row cap; re-querying one component at a time.');
            rows = null;
          }
        } catch (e) {
          this.log(`IN filter not accepted (${e.message}); querying one at a time.`, 'warn');
          this.inSupported = false;
        }
      }
      if (!rows) {
        rows = [];
        await pool(chunk, 4, async id => {
          const r = await this.sf.tooling(`SELECT ${MCD_FIELDS} FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${soqlStr(id)}'`);
          if (r.length >= TOOLING_CAP) this.warn(`Component ${id} has 2,000+ references; list may be incomplete.`);
          rows.push(...r);
        });
      }
      for (const id of chunk) this.cache.set(id, []);
      for (const r of rows) {
        const k = r.RefMetadataComponentId;
        if (!this.cache.has(k)) this.cache.set(k, []);
        this.cache.get(k).push(r);
      }
    }
    return ids.flatMap(id => this.cache.get(id) || []);
  }

  // ---------- Graph ----------

  /**
   * @param targets     components being removed (unmanaged/custom mode); managed mode: []
   * @param level1Rows  MCD rows of direct references
   * @param textRows    extra blockers from text scan [{id,type,name,matches:Set,objectName}]
   * @param actionOf    node -> 'delete' | 'modify' | 'other-package'
   */
  async build({ targets = [], level1Rows = [], textRows = [], actionOf, maxDepth = 8 }) {
    const nodes = new Map();
    const targetIds = new Set(targets.map(t => t.id));
    for (const t of targets) {
      nodes.set(t.id, { ...t, role: 'target', level: 0, refs: new Set(), refLabels: new Set(), sources: new Set(['package']), matches: new Set() });
    }

    const add = (r, level) => {
      const id = r.MetadataComponentId;
      if (!id || targetIds.has(id)) {
        // internal reference between targets: keep the edge for ordering
        if (id && targetIds.has(id) && r.RefMetadataComponentId) nodes.get(id).refs.add(r.RefMetadataComponentId);
        return null;
      }
      let n = nodes.get(id), fresh = false;
      const refNode = nodes.get(r.RefMetadataComponentId);
      if (refNode) level = refNode.level + 1;
      if (!n) {
        n = { id, type: r.MetadataComponentType, name: r.MetadataComponentName, ns: r.MetadataComponentNamespace || '',
              level, role: 'blocker', refs: new Set(), refLabels: new Set(), sources: new Set(), matches: new Set() };
        nodes.set(id, n);
        fresh = true;
      }
      n.sources.add('dependency');
      if (r.RefMetadataComponentId) n.refs.add(r.RefMetadataComponentId);
      n.refLabels.add(`${r.RefMetadataComponentName} · ${r.RefMetadataComponentType}`);
      return fresh ? n : null;
    };

    let frontier = [];
    for (const r of level1Rows) { const n = add(r, 1); if (n) frontier.push(n); }
    for (const t of textRows) {
      if (targetIds.has(t.id)) continue;
      let n = nodes.get(t.id);
      if (!n) {
        n = { id: t.id, type: t.type, name: t.name, ns: t.ns || '', level: t.level || 1, role: 'blocker', objectName: t.objectName,
              refs: new Set(), refLabels: new Set(), sources: new Set(), matches: new Set() };
        nodes.set(t.id, n);
        frontier.push(n);
      }
      const src = t.source || 'text';
      n.sources.add(src);
      if (t.level && t.level > n.level) n.level = t.level;
      if (t.suggested && !n.suggested) n.suggested = t.suggested;
      if (t.reason && !n.reason) n.reason = t.reason;
      if (t.fullName && !n.fullName) n.fullName = t.fullName;
      if (t.objectName && !n.objectName) n.objectName = t.objectName;
      for (const r of t.refs || []) n.refs.add(r);
      for (const m of t.matches) { n.matches.add(m); n.refLabels.add(src === 'text' ? `${m} · text match` : m); }
    }

    let level = 1;
    while (frontier.length) {
      const expand = frontier.filter(n => actionOf(n) === 'delete');
      if (!expand.length) break;
      if (level >= maxDepth) {
        this.warn(`Stopped at depth ${maxDepth}. ${expand.length} component(s) still need checking — raise "Max depth" and re-scan.`);
        break;
      }
      this.log(`Level ${level + 1}: checking what blocks deleting ${expand.length} component(s)…`);
      const rows = await this.referrersOf(expand.map(n => n.id));
      const next = [];
      for (const r of rows) { const n = add(r, level + 1); if (n) next.push(n); }
      frontier = next;
      level++;
    }
    return nodes;
  }

  // ---------- Enrichment (full names for links + destructive deploy) ----------

  async enrich(nodes, { limit = 800 } = {}) {
    try { await this.enrichAnalytics(nodes); } catch (e) { this.warn(`Couldn't resolve report/dashboard folders: ${e.message}`); }
    const todo = [...nodes.values()].filter(n => !n.fullName && n.id && !this.badEnrichTypes.has(n.type));
    if (todo.length > limit) this.warn(`Only resolving names for the first ${limit} of ${todo.length} components.`);
    let done = 0;
    await pool(todo.slice(0, limit), 6, async n => {
      if (!this.enriched.has(n.id)) {
        try { this.enriched.set(n.id, await this.fetchFullName(n)); }
        catch (e) {
          if (/INVALID_TYPE|INVALID_FIELD|not supported|MALFORMED/i.test(e.message)) this.badEnrichTypes.add(n.type);
          this.enriched.set(n.id, null);
        }
      }
      const info = this.enriched.get(n.id);
      if (info) Object.assign(n, info);
      if (++done % 50 === 0) this.log(`  resolved ${done}/${todo.length} names…`);
    });
    for (const n of nodes.values()) {
      if (!n.objectName && n.fullName) n.objectName = objectFromFullName(n.type, n.fullName);
    }
  }

  async fetchFullName(n) {
    const id = soqlStr(n.id);
    if (n.type === 'Flow') {
      if (n.id.startsWith('300')) {
        const d = await this.sf.tooling(`SELECT Id, DeveloperName FROM FlowDefinition WHERE Id = '${id}'`);
        return d.length ? { fullName: d[0].DeveloperName, definitionId: d[0].Id } : null;
      }
      const r = await this.sf.tooling(`SELECT Id, DefinitionId, VersionNumber, Status, Definition.DeveloperName FROM Flow WHERE Id = '${id}'`);
      if (!r.length) return null;
      return { fullName: (r[0].Definition && r[0].Definition.DeveloperName) || n.name,
               definitionId: r[0].DefinitionId, version: r[0].VersionNumber, status: r[0].Status };
    }
    if (n.type === 'Report' || n.type === 'Dashboard') return null;
    const sobj = TOOLING_SOBJECT[n.type] || n.type;
    const r = await this.sf.tooling(`SELECT Id, FullName FROM ${sobj} WHERE Id = '${id}'`);
    if (!r.length || !r[0].FullName) return null;
    return { fullName: r[0].FullName, objectName: objectFromFullName(n.type, r[0].FullName) };
  }

  // ---------- Reports, dashboards, report types ----------

  // Folder developer names -> "Folder/DevName" full names for reports & dashboards.
  async folderNames(ownerIds) {
    const ids = [...new Set(ownerIds.filter(i => i && i.startsWith('00l')))];
    const map = new Map();
    for (const c of chunks(ids, 200)) {
      const rows = await this.sf.query(`SELECT Id, DeveloperName FROM Folder WHERE Id IN (${c.map(i => `'${soqlStr(i)}'`).join(',')})`);
      for (const r of rows) map.set(r.Id, r.DeveloperName);
    }
    return owner => {
      if (!owner) return null;
      if (owner.startsWith('00D')) return 'unfiled$public';
      return map.get(owner) || null; // private (005) folders can't be deployed
    };
  }

  async enrichAnalytics(nodes) {
    const reps = [...nodes.values()].filter(n => n.type === 'Report' && !n.fullName);
    const dash = [...nodes.values()].filter(n => n.type === 'Dashboard' && !n.fullName);
    if (!reps.length && !dash.length) return;
    const rr = [], dd = [];
    for (const c of chunks(reps.map(n => n.id), 200))
      rr.push(...await this.sf.query(`SELECT Id, Name, DeveloperName, OwnerId FROM Report WHERE Id IN (${c.map(i => `'${soqlStr(i)}'`).join(',')})`));
    for (const c of chunks(dash.map(n => n.id), 200))
      dd.push(...await this.sf.query(`SELECT Id, Title, DeveloperName, FolderId FROM Dashboard WHERE Id IN (${c.map(i => `'${soqlStr(i)}'`).join(',')})`));
    const folder = await this.folderNames([...rr.map(r => r.OwnerId), ...dd.map(d => d.FolderId)]);
    for (const r of rr) { const n = nodes.get(r.Id); const f = folder(r.OwnerId); if (n) { n.fullName = f ? `${f}/${r.DeveloperName}` : null; n.privateFolder = !f; } }
    for (const d of dd) { const n = nodes.get(d.Id); const f = folder(d.FolderId); if (n) { n.fullName = f ? `${f}/${d.DeveloperName}` : null; n.privateFolder = !f; } }
  }

  // One cheap query for every report's type, folder and run date (no per-report calls).
  async listReports() {
    if (this.reportList) return this.reportList;
    this.log('Report scan: listing reports and their report types…');
    let all;
    try {
      all = await this.sf.query('SELECT Id, Name, DeveloperName, OwnerId, NamespacePrefix, LastRunDate, ReportTypeApiName FROM Report ORDER BY LastRunDate DESC NULLS LAST');
      this.reportTypeKnown = true;
    } catch (e) {
      this.warn(`This org doesn't return report types in SOQL (${e.message}). Falling back to reading report definitions, limited by "Max reports".`);
      all = await this.sf.query('SELECT Id, Name, DeveloperName, OwnerId, NamespacePrefix, LastRunDate FROM Report ORDER BY LastRunDate DESC NULLS LAST');
      this.reportTypeKnown = false;
    }
    const folder = await this.folderNames(all.map(r => r.OwnerId));
    this.reportList = all.map(r => {
      const f = folder(r.OwnerId);
      return { id: r.Id, name: r.Name, ns: r.NamespacePrefix || '', reportType: r.ReportTypeApiName || '',
               fullName: f ? `${f}/${r.DeveloperName}` : null, privateFolder: !f };
    });
    return this.reportList;
  }

  // Reads definitions only for the given reports (cached across passes).
  async describeReports(list) {
    if (!this.reportDesc) this.reportDesc = new Map();
    const need = list.filter(r => !this.reportDesc.has(r.id));
    if (need.length) this.log(`Report scan: reading ${need.length} report definition(s)…`);
    let i = 0, failed = 0;
    await pool(need, 6, async r => {
      try {
        const d = await this.sf.req(`${this.sf.dataPath}/analytics/reports/${r.id}/describe`);
        const m = d.reportMetadata || {};
        this.reportDesc.set(r.id, {
          reportType: (m.reportType && m.reportType.type) || r.reportType,
          json: JSON.stringify({ t: m.reportType, c: m.detailColumns, g: [m.groupingsDown, m.groupingsAcross], f: m.reportFilters,
                                 x: m.crossFilters, a: m.aggregates, b: m.reportBooleanFilter, s: m.standardFilters, bk: m.buckets })
        });
      } catch (e) { failed++; this.reportDesc.set(r.id, null); }
      if (++i % 100 === 0) this.log(`  reports ${i}/${need.length}…`);
    });
    if (failed) this.warn(`${failed} report(s) couldn't be read (no access or broken report type). Check them manually if the uninstall still fails.`);
    return list.map(r => ({ ...r, ...(this.reportDesc.get(r.id) || { json: null }) })).filter(r => r.json);
  }

  // Objects owned by the package, and objects that carry package fields.
  async packageObjects(ns) {
    if (this.pkgObjects && this.pkgObjects.ns === ns) return this.pkgObjects;
    const owned = new Set(), withFields = new Set();
    try {
      for (const e of await this.sf.tooling(`SELECT QualifiedApiName FROM EntityDefinition WHERE NamespacePrefix = '${soqlStr(ns)}'`))
        owned.add(e.QualifiedApiName);
    } catch (e) { this.warn(`Couldn't list package objects: ${e.message}`); }
    try {
      const f = await this.sf.tooling(`SELECT TableEnumOrId FROM CustomField WHERE NamespacePrefix = '${soqlStr(ns)}'`);
      const ids = [...new Set(f.map(x => x.TableEnumOrId).filter(t => /^01I/.test(t)))];
      f.map(x => x.TableEnumOrId).filter(t => t && !/^01I/.test(t)).forEach(t => withFields.add(t));
      for (const c of chunks(ids, 100)) {
        for (const o of await this.sf.tooling(`SELECT Id, DeveloperName, NamespacePrefix FROM CustomObject WHERE Id IN (${c.map(i => `'${i}'`).join(',')})`))
          withFields.add(`${o.NamespacePrefix ? o.NamespacePrefix + '__' : ''}${o.DeveloperName}__c`);
      }
    } catch (e) { this.warn(`Couldn't list package fields by object: ${e.message}`); }
    this.pkgObjects = { ns, owned, withFields };
    this.log(`Package has ${owned.size} object(s) and adds fields to ${[...withFields].filter(o => !owned.has(o)).length} other object(s).`);
    return this.pkgObjects;
  }

  // Child objects of `obj` (their standard reports can show the parent's fields through the lookup).
  async childObjects(obj) {
    if (!this.childCache) this.childCache = new Map();
    if (this.childCache.has(obj)) return this.childCache.get(obj);
    let kids = [];
    if (!SKIP_CHILD_EXPANSION.has(obj)) {
      try {
        const d = await this.sf.req(`${this.sf.dataPath}/sobjects/${obj}/describe`);
        kids = [...new Set((d.childRelationships || []).map(c => c.childSObject))].filter(k => k && !/(History|Share|Feed|ChangeEvent|Tag)$/.test(k));
      } catch (e) { /* object not describable */ }
    }
    this.childCache.set(obj, kids);
    return kids;
  }

  async relevantObjects(nodes, { ns, children = true }) {
    const core = new Set();
    if (ns) {
      const p = await this.packageObjects(ns);
      p.owned.forEach(o => core.add(o));
      p.withFields.forEach(o => core.add(o));
    }
    for (const n of nodes.values()) {
      const deleting = n.role === 'target' || n.__del;
      if (!deleting) continue;
      if (n.type === 'CustomField' && n.fullName && n.fullName.includes('.')) core.add(n.fullName.split('.')[0]);
      if (n.type === 'CustomObject' && n.fullName) core.add(n.fullName);
    }
    const all = new Set(core);
    if (children) {
      for (const o of core) for (const k of await this.childObjects(o)) all.add(k);
    }
    return { core, all };
  }

  async loadReportTypes() {
    if (this.reportTypes) return this.reportTypes;
    this.log('Report types: listing custom report types…');
    const list = (await this.sf.listMetadata('ReportType')).filter(r => r.fullName);
    const recs = await this.sf.readMetadata('ReportType', list.map(r => r.fullName));
    const byName = new Map(list.map(r => [r.fullName, r]));
    this.reportTypes = recs.map(rec => {
      const meta = byName.get(rec.fullName) || {};
      const base = (rec.xml.match(/<(?:\w+:)?baseObject>([^<]+)</) || [])[1] || '';
      return { id: meta.id || '', fullName: rec.fullName, ns: meta.namespacePrefix || '', baseObject: base, xml: rec.xml };
    });
    this.log(`Report types: ${this.reportTypes.length} custom report type(s) read.`);
    return this.reportTypes;
  }

  async dashboardsFor(reportIds) {
    const need = reportIds.filter(id => !this.dashByReport.has(id));
    if (need.length) {
      need.forEach(id => this.dashByReport.set(id, []));
      let comps = [];
      try {
        for (const c of chunks(need, 200))
          comps.push(...await this.sf.query(`SELECT Id, DashboardId, CustomReportId FROM DashboardComponent WHERE CustomReportId IN (${c.map(i => `'${soqlStr(i)}'`).join(',')})`));
      } catch (e) {
        this.warn(`Dashboard lookup by query failed (${e.message}); dashboards may be incomplete.`);
        comps = [];
      }
      const dashIds = [...new Set(comps.map(c => c.DashboardId))];
      const dmap = new Map();
      for (const c of chunks(dashIds, 200)) {
        for (const d of await this.sf.query(`SELECT Id, Title, DeveloperName, FolderId, NamespacePrefix FROM Dashboard WHERE Id IN (${c.map(i => `'${soqlStr(i)}'`).join(',')})`)) dmap.set(d.Id, d);
      }
      const folder = await this.folderNames([...dmap.values()].map(d => d.FolderId));
      for (const c of comps) {
        const d = dmap.get(c.DashboardId);
        if (!d) continue;
        const list = this.dashByReport.get(c.CustomReportId) || [];
        if (!list.some(x => x.id === d.Id)) {
          const f = folder(d.FolderId);
          list.push({ id: d.Id, name: d.Title, ns: d.NamespacePrefix || '', fullName: f ? `${f}/${d.DeveloperName}` : null, privateFolder: !f });
        }
        this.dashByReport.set(c.CustomReportId, list);
      }
    }
    return reportIds.flatMap(id => (this.dashByReport.get(id) || []).map(d => ({ ...d, reportId: id })));
  }

  /**
   * Extra blocker rows from report definitions, custom report types and dashboards.
   * Matches the package namespace (managed mode) and every field/object currently marked for deletion.
   */
  async analyticsRows(nodes, { ns = null, actionOf, reports = true, reportTypes = true, reportCap = 3000, reportScope = 'related', childReports = true }) {
    const rows = [];
    const nsRe = ns ? new RegExp(`\\b${escapeRe(ns)}__[A-Za-z0-9_]+`, 'gi') : null;
    const effective = r => actionOf({ id: r.id, type: r.type, role: 'blocker', ns: r.ns || '', sources: new Set(['analytics']), suggested: r.suggested });
    const lvl = refs => Math.max(0, ...[...refs].map(id => (nodes.get(id) || {}).level || 0)) + 1;

    // tokens for components being deleted
    const fieldTok = [], objTok = [];
    for (const n of nodes.values()) {
      if (actionOf(n) !== 'delete' || !n.fullName) continue;
      if (n.type === 'CustomField' && n.fullName.includes('.')) {
        const [obj, field] = n.fullName.split('.');
        fieldTok.push({ id: n.id, obj, field, re: new RegExp(`\\b${escapeRe(field)}\\b`, 'i'), label: `${n.fullName} · CustomField` });
      } else if (n.type === 'CustomObject') {
        objTok.push({ id: n.id, obj: n.fullName, re: new RegExp(`\\b${escapeRe(n.fullName)}\\b`, 'i'), label: `${n.fullName} · CustomObject` });
      }
    }
    const scanText = (text, ownNs) => {
      const matches = new Set(), refs = new Set();
      if (nsRe && ownNs.toLowerCase() !== ns.toLowerCase()) for (const m of (text.match(nsRe) || [])) matches.add(`${m.replace(/^(\w+?)__/i, `${ns}__`)} · in definition`);
      for (const t of fieldTok) if (t.re.test(text) && text.toLowerCase().includes(t.obj.toLowerCase())) { matches.add(t.label); refs.add(t.id); }
      for (const t of objTok) if (t.re.test(text)) { matches.add(t.label); refs.add(t.id); }
      return { matches, refs };
    };

    // 1. custom report types
    for (const n of nodes.values()) n.__del = actionOf(n) === 'delete';
    const scoped = reports && reportScope !== 'all';
    const coreObjs = scoped ? (await this.relevantObjects(nodes, { ns, children: false })).core : new Set();
    const rtDelete = new Map(); // normalized fullName -> row
    const rtRelevant = new Set(); // CRT names touching the plan (reports on them get read)
    if (reportTypes) {
      try {
        for (const rt of await this.loadReportTypes()) {
          if (ns && rt.ns.toLowerCase() === ns.toLowerCase()) continue;
          const { matches, refs } = scanText(rt.xml, rt.ns);
          if (!matches.size) {
            // no direct reference, but reports on it may still show package/deleted fields of its objects
            if (scoped) {
              const x = rt.xml.toLowerCase();
              if ([...coreObjs].some(o => x.includes(`>${o.toLowerCase()}<`))) rtRelevant.add(rt.fullName);
            }
            continue;
          }
          const baseHit = (nsRe && new RegExp(`^${escapeRe(ns)}__`, 'i').test(rt.baseObject)) || objTok.some(t => t.obj.toLowerCase() === rt.baseObject.toLowerCase());
          const row = { id: rt.id || `rt:${rt.fullName}`, type: 'ReportType', name: rt.fullName, fullName: rt.fullName, ns: rt.ns, source: 'analytics',
                        matches, refs, level: lvl(refs), suggested: baseHit ? 'delete' : undefined,
                        reason: baseHit ? `Built on ${rt.baseObject}, which is being removed.` : '' };
          rows.push(row);
          rtRelevant.add(rt.fullName);
          if (effective(row) === 'delete') rtDelete.set(normRT(rt.fullName), row);
        }
      } catch (e) { this.warn(`Report type scan skipped: ${e.message}`); }
    }

    // 2. reports — only those whose report type touches the objects in this plan
    const reportRows = [];
    if (reports) {
      try {
        const listAll = await this.listReports();
        const pool0 = listAll.filter(r => !(ns && r.ns.toLowerCase() === ns.toLowerCase()));
        let candidates;
        if (reportScope === 'all' || !this.reportTypeKnown) {
          candidates = pool0.slice(0, reportCap);
          if (pool0.length > reportCap) this.warn(`Report scan covered the ${reportCap} most recently run of ${pool0.length} reports. Raise "Max reports" to scan more.`);
        } else {
          const { all: objs } = await this.relevantObjects(nodes, { ns, children: childReports });
          const crtNames = new Set([...rtRelevant].map(n => n.toLowerCase()));
          candidates = pool0.filter(r => reportTypeTouches(r.reportType, objs, ns, crtNames));
          this.note(`Report scan: ${candidates.length.toLocaleString()} of ${listAll.length.toLocaleString()} reports use report types on the ${objs.size} related object(s), so only those were read.`);
        }
        for (const r of await this.describeReports(candidates)) {
          const { matches, refs } = scanText(r.json, r.ns);
          const rt = rtDelete.get(normRT(r.reportType));
          if (rt) { matches.add(`${rt.name} · ReportType`); refs.add(rt.id); }
          const pkgType = nsRe && new RegExp(`(^|\\$)${escapeRe(ns)}__`, 'i').test(r.reportType || '');
          if (!matches.size) continue;
          const row = { id: r.id, type: 'Report', name: r.name, fullName: r.fullName, privateFolder: r.privateFolder, ns: r.ns, source: 'analytics',
                        matches, refs, level: Math.max(lvl(refs), rt ? rt.level + 1 : 1),
                        suggested: (rt || pkgType) ? 'delete' : undefined,
                        reason: rt ? `Uses report type ${rt.name}, which is being deleted.` : pkgType ? `Uses the package's report type ${r.reportType}.` : '' };
          rows.push(row);
          reportRows.push(row);
        }
      } catch (e) { this.warn(`Report scan skipped: ${e.message}`); }
    }

    // 3. dashboards on reports that will be deleted
    if (reports) {
      const delReports = [
        ...reportRows.filter(r => effective(r) === 'delete').map(r => r.id),
        ...[...nodes.values()].filter(n => n.type === 'Report' && actionOf(n) === 'delete').map(n => n.id)
      ];
      if (delReports.length) {
        try {
          const byId = new Map();
          for (const d of await this.dashboardsFor([...new Set(delReports)])) {
            if (ns && d.ns.toLowerCase() === ns.toLowerCase()) continue;
            const rep = reportRows.find(r => r.id === d.reportId) || nodes.get(d.reportId);
            if (!byId.has(d.id)) byId.set(d.id, { id: d.id, type: 'Dashboard', name: d.name, fullName: d.fullName, privateFolder: d.privateFolder, ns: d.ns,
                                                  source: 'analytics', matches: new Set(), refs: new Set(), level: 1 });
            const row = byId.get(d.id);
            row.refs.add(d.reportId);
            row.matches.add(`${rep ? rep.name : d.reportId} · Report`);
            row.level = Math.max(row.level, ((rep && rep.level) || 1) + 1);
          }
          rows.push(...byId.values());
        } catch (e) { this.warn(`Dashboard scan skipped: ${e.message}`); }
      }
    }
    return rows;
  }

  // ---------- Text scan (catches what the Dependency API misses) ----------

  async textScan(ns, { listViews = false } = {}) {
    const re = new RegExp(`\\b${escapeRe(ns)}__[A-Za-z0-9_]+`, 'gi');
    const rows = [];
    const hit = (id, type, name, text, extra = {}) => {
      const m = new Set(((text || '').match(re) || []).map(s => s.replace(/^(\w+?)__/i, `${ns}__`)));
      if (m.size) rows.push({ id, type, name, matches: m, ...extra });
    };
    const noComments = s => (s || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const step = async (label, fn) => {
      this.log(`Text scan: ${label}…`);
      try { await fn(); } catch (e) { this.warn(`Text scan of ${label} skipped: ${e.message}`); }
    };

    await step('Apex classes', async () => {
      for (const r of await this.sf.tooling('SELECT Id, Name, Body FROM ApexClass WHERE NamespacePrefix = null'))
        hit(r.Id, 'ApexClass', r.Name, noComments(r.Body));
    });
    await step('Apex triggers', async () => {
      for (const r of await this.sf.tooling('SELECT Id, Name, Body, TableEnumOrId FROM ApexTrigger WHERE NamespacePrefix = null'))
        hit(r.Id, 'ApexTrigger', r.Name, noComments(r.Body), { objectName: r.TableEnumOrId });
    });
    await step('Visualforce pages', async () => {
      for (const r of await this.sf.tooling('SELECT Id, Name, Markup FROM ApexPage WHERE NamespacePrefix = null'))
        hit(r.Id, 'ApexPage', r.Name, r.Markup);
    });
    await step('Visualforce components', async () => {
      for (const r of await this.sf.tooling('SELECT Id, Name, Markup FROM ApexComponent WHERE NamespacePrefix = null'))
        hit(r.Id, 'ApexComponent', r.Name, r.Markup);
    });
    await step('email templates', async () => {
      for (const r of await this.sf.query('SELECT Id, Name, Subject, Body, HtmlValue FROM EmailTemplate WHERE NamespacePrefix = null'))
        hit(r.Id, 'EmailTemplate', r.Name, [r.Subject, r.Body, r.HtmlValue].join('\n'));
    });
    await step('workflow rules', async () => {
      const list = (await this.sf.tooling('SELECT Id, Name, TableEnumOrId, NamespacePrefix FROM WorkflowRule'))
        .filter(r => !r.NamespacePrefix);
      const capped = list.slice(0, 1000);
      if (list.length > capped.length) this.warn(`Only the first 1,000 of ${list.length} workflow rules were text-scanned.`);
      await pool(capped, 6, async r => {
        const d = await this.sf.tooling(`SELECT Id, Metadata FROM WorkflowRule WHERE Id = '${soqlStr(r.Id)}'`);
        if (d.length) hit(r.Id, 'WorkflowRule', r.Name, JSON.stringify(d[0].Metadata), { objectName: r.TableEnumOrId });
      });
    });
    if (listViews) {
      await step('list views', async () => {
        const lower = ns.toLowerCase() + '__';
        const list = (await this.sf.query('SELECT Id, Name, DeveloperName, SobjectType FROM ListView'))
          .filter(v => v.SobjectType && !v.SobjectType.toLowerCase().startsWith(lower));
        const capped = list.slice(0, 3000);
        if (list.length > capped.length) this.warn(`Only the first 3,000 of ${list.length} list views were scanned.`);
        let i = 0;
        await pool(capped, 6, async v => {
          try {
            const d = await this.sf.req(`${this.sf.dataPath}/sobjects/${v.SobjectType}/listviews/${v.Id}/describe`);
            hit(v.Id, 'ListView', `${v.SobjectType}: ${v.Name}`, JSON.stringify(d),
                { objectName: v.SobjectType, fullName: `${v.SobjectType}.${v.DeveloperName}` });
          } catch (e) { /* some list views can't be described */ }
          if (++i % 200 === 0) this.log(`  list views ${i}/${capped.length}…`);
        });
      });
    }
    this.log(`Text scan found ${rows.length} component(s) with ${ns}__ references.`);
    return rows;
  }
}

// ---------- Default actions ----------

export function defaultAction(n, { mode, ns }) {
  if (n.role === 'target') return 'delete';
  if (n.ns && (mode !== 'managed' || n.ns.toLowerCase() !== String(ns || '').toLowerCase())) return 'other-package';
  if (n.suggested) return n.suggested;
  if (!n.sources.has('dependency')) return 'modify'; // text-only matches: edit, don't assume delete
  return typeInfo(n.type).action;
}

// ---------- Ordering ----------

const ACTION_RANK = { 'other-package': 0, modify: 1, delete: 2 };

/**
 * Orders nodes so each one is fixed before anything it references.
 * Circular references become one group ("delete together in one deploy").
 * Returns [{ ids: [...], cycle: bool }] in fix order.
 */
export function planOrder(nodes, actionOf) {
  const ids = [...nodes.keys()];
  const idx = new Map(ids.map((id, i) => [id, i]));
  const adj = ids.map(id => [...nodes.get(id).refs].filter(r => r !== id && idx.has(r)).map(r => idx.get(r)));

  // Tarjan SCC (iterative)
  const N = ids.length;
  const index = new Array(N).fill(-1), low = new Array(N).fill(0), onStack = new Array(N).fill(false), comp = new Array(N).fill(-1);
  const stack = [], comps = [];
  let counter = 0;
  for (let s = 0; s < N; s++) {
    if (index[s] >= 0) continue;
    const work = [[s, 0]];
    index[s] = low[s] = counter++; stack.push(s); onStack[s] = true;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, pi] = top;
      if (pi < adj[v].length) {
        top[1]++;
        const w = adj[v][pi];
        if (index[w] < 0) {
          index[w] = low[w] = counter++; stack.push(w); onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
        if (low[v] === index[v]) {
          const c = [];
          let w;
          do { w = stack.pop(); onStack[w] = false; comp[w] = comps.length; c.push(w); } while (w !== v);
          comps.push(c);
        }
      }
    }
  }

  // Condensed DAG + Kahn (edge: referrer -> referenced; referrers go first)
  const cadj = comps.map(() => new Set());
  const indeg = new Array(comps.length).fill(0);
  adj.forEach((ws, v) => ws.forEach(w => {
    const a = comp[v], b = comp[w];
    if (a !== b && !cadj[a].has(b)) { cadj[a].add(b); indeg[b]++; }
  }));

  const key = c => {
    const ns = comps[c].map(i => nodes.get(ids[i]));
    return {
      level: Math.max(...ns.map(n => n.level)),
      action: Math.min(...ns.map(n => n.role === 'target' ? 3 : (ACTION_RANK[actionOf(n)] ?? 1))),
      type: Math.min(...ns.map(n => typeRank(n.type))),
      name: ns.map(n => n.name || '').sort()[0]
    };
  };
  const cmp = (a, b) => {
    const x = key(a), y = key(b);
    return (y.level - x.level) || (x.action - y.action) || (x.type - y.type) || x.name.localeCompare(y.name);
  };

  const ready = [];
  comps.forEach((_, c) => { if (indeg[c] === 0) ready.push(c); });
  const out = [];
  while (ready.length) {
    ready.sort(cmp);
    const c = ready.shift();
    out.push(c);
    for (const w of cadj[c]) if (--indeg[w] === 0) ready.push(w);
  }

  return out.map(c => ({
    cycle: comps[c].length > 1,
    ids: comps[c].map(i => ids[i]).sort((a, b) => nodes.get(b).level - nodes.get(a).level)
  }));
}
