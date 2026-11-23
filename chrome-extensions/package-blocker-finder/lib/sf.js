// Salesforce API client: REST, Tooling, Bulk API 2.0 (Tooling) and Metadata SOAP.
import { parseCSV, sleep, xmlEsc } from './util.js';

export class SF {
  constructor({ host, sid, version = '62.0', fetchImpl }) {
    this.host = host;
    this.sid = sid;
    this.version = version;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.calls = 0;
  }

  get base() { return `https://${this.host}`; }
  get dataPath() { return `/services/data/v${this.version}`; }

  async detectVersion() {
    try {
      const res = await this.fetch(`${this.base}/services/data/`);
      const list = await res.json();
      if (Array.isArray(list) && list.length) this.version = list[list.length - 1].version;
    } catch (e) { /* keep default */ }
    return this.version;
  }

  async req(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
    this.calls++;
    const url = path.startsWith('http') ? path : this.base + path;
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.sid}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    if (!res.ok) {
      let msg = await res.text();
      try {
        const j = JSON.parse(msg);
        msg = Array.isArray(j) ? j.map(e => `${e.errorCode}: ${e.message}`).join('; ') : (j.message || msg);
      } catch (e) { /* plain text */ }
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      throw err;
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async query(soql, tooling = false) {
    const p = tooling ? '/tooling' : '';
    let r = await this.req(`${this.dataPath}${p}/query/?q=${encodeURIComponent(soql)}`);
    const out = [...(r.records || [])];
    while (r && !r.done && r.nextRecordsUrl) {
      r = await this.req(r.nextRecordsUrl);
      out.push(...(r.records || []));
    }
    return out;
  }

  tooling(soql) { return this.query(soql, true); }

  // Bulk API 2.0 query against a Tooling object (up to 100k MetadataComponentDependency rows, includes Reports).
  async toolingBulk(soql, onStatus = () => {}) {
    const job = await this.req(`${this.dataPath}/tooling/jobs/query`, {
      method: 'POST', body: { operation: 'query', query: soql }
    });
    let state = job.state;
    for (let i = 0; i < 300; i++) {
      const info = await this.req(`${this.dataPath}/tooling/jobs/query/${job.id}`);
      state = info.state;
      onStatus(`${state}${info.numberRecordsProcessed ? ` (${info.numberRecordsProcessed} rows)` : ''}`);
      if (state === 'JobComplete') break;
      if (state === 'Failed' || state === 'Aborted') throw new Error(`Bulk job ${state}: ${info.errorMessage || ''}`);
      await sleep(2000);
    }
    if (state !== 'JobComplete') throw new Error('Bulk job timed out');
    const rows = [];
    let locator = null;
    do {
      const url = `${this.dataPath}/tooling/jobs/query/${job.id}/results?maxRecords=50000${locator ? `&locator=${locator}` : ''}`;
      const res = await this.req(url, { raw: true, headers: { Accept: 'text/csv' } });
      rows.push(...parseCSV(await res.text()));
      locator = res.headers.get('Sforce-Locator');
    } while (locator && locator !== 'null');
    return rows;
  }

  async deleteTooling(type, id) {
    return this.req(`${this.dataPath}/tooling/sobjects/${type}/${id}`, { method: 'DELETE' });
  }

  async patchTooling(type, id, body) {
    return this.req(`${this.dataPath}/tooling/sobjects/${type}/${id}`, { method: 'PATCH', body });
  }

  // ---------- Metadata API (SOAP) ----------
  async soap(inner) {
    this.calls++;
    const env = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
<soapenv:Header><met:SessionHeader><met:sessionId>${xmlEsc(this.sid)}</met:sessionId></met:SessionHeader></soapenv:Header>
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
    const res = await this.fetch(`${this.base}/services/Soap/m/${this.version}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' },
      body: env
    });
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const fault = doc.getElementsByTagName('faultstring')[0];
    if (fault) throw new Error(fault.textContent);
    if (!res.ok) throw new Error(`SOAP ${res.status}`);
    return doc;
  }

  // Lists the components of an unmanaged (or any named) package via Metadata API retrieve.
  async retrievePackageMembers(packageName, onStatus = () => {}) {
    const doc = await this.soap(`<met:retrieve><met:retrieveRequest>
<met:apiVersion>${this.version}</met:apiVersion>
<met:packageNames>${xmlEsc(packageName)}</met:packageNames>
<met:singlePackage>false</met:singlePackage>
</met:retrieveRequest></met:retrieve>`);
    const id = tag(doc, 'id');
    for (let i = 0; i < 200; i++) {
      await sleep(2000);
      const st = await this.soap(`<met:checkRetrieveStatus><met:asyncProcessId>${id}</met:asyncProcessId><met:includeZip>false</met:includeZip></met:checkRetrieveStatus>`);
      const status = tag(st, 'status');
      onStatus(status);
      if (tag(st, 'done') === 'true') {
        if (status !== 'Succeeded') throw new Error(`Retrieve ${status}: ${tag(st, 'errorMessage') || ''}`);
        const msgs = [...st.getElementsByTagNameNS('*', 'messages')].map(m => tag(m, 'problem')).filter(Boolean);
        if (msgs.length) onStatus(`warnings: ${msgs.join(' | ')}`);
        return [...st.getElementsByTagNameNS('*', 'fileProperties')].map(fp => ({
          id: tag(fp, 'id'), type: tag(fp, 'type'), fullName: tag(fp, 'fullName'),
          fileName: tag(fp, 'fileName'), namespacePrefix: tag(fp, 'namespacePrefix')
        }));
      }
    }
    throw new Error('Retrieve timed out');
  }

  // [{fullName, id, namespacePrefix}] for one metadata type
  async listMetadata(type) {
    const doc = await this.soap(`<met:listMetadata><met:queries><met:type>${xmlEsc(type)}</met:type></met:queries><met:asOfVersion>${this.version}</met:asOfVersion></met:listMetadata>`);
    return [...doc.getElementsByTagNameNS('*', 'result')].map(r => ({
      fullName: tag(r, 'fullName'), id: tag(r, 'id'), namespacePrefix: tag(r, 'namespacePrefix')
    }));
  }

  // [{fullName, xml}] — readMetadata allows 10 names per call
  async readMetadata(type, fullNames) {
    const out = [];
    for (let i = 0; i < fullNames.length; i += 10) {
      const names = fullNames.slice(i, i + 10).map(n => `<met:fullNames>${xmlEsc(n)}</met:fullNames>`).join('');
      const doc = await this.soap(`<met:readMetadata><met:type>${xmlEsc(type)}</met:type>${names}</met:readMetadata>`);
      for (const rec of doc.getElementsByTagNameNS('*', 'records')) {
        out.push({ fullName: tag(rec, 'fullName'), xml: new XMLSerializer().serializeToString(rec) });
      }
    }
    return out;
  }

  async deploy(zipBase64, { checkOnly = true, testLevel = 'NoTestRun', purgeOnDelete = false } = {}) {
    // Element order follows the DeployOptions sequence in the Metadata WSDL.
    const doc = await this.soap(`<met:deploy><met:ZipFile>${zipBase64}</met:ZipFile><met:DeployOptions>
<met:checkOnly>${checkOnly}</met:checkOnly>
<met:ignoreWarnings>false</met:ignoreWarnings>
<met:purgeOnDelete>${purgeOnDelete}</met:purgeOnDelete>
<met:rollbackOnError>true</met:rollbackOnError>
<met:singlePackage>true</met:singlePackage>
<met:testLevel>${testLevel}</met:testLevel>
</met:DeployOptions></met:deploy>`);
    return tag(doc, 'id');
  }

  async checkDeploy(id) {
    const doc = await this.soap(`<met:checkDeployStatus><met:asyncProcessId>${id}</met:asyncProcessId><met:includeDetails>true</met:includeDetails></met:checkDeployStatus>`);
    const failures = [...doc.getElementsByTagNameNS('*', 'componentFailures')].map(f => ({
      type: tag(f, 'componentType'), name: tag(f, 'fullName'), problem: tag(f, 'problem')
    }));
    const testFailures = [...doc.getElementsByTagNameNS('*', 'failures')].map(f => ({
      type: 'Test', name: `${tag(f, 'name')}.${tag(f, 'methodName')}`, problem: tag(f, 'message')
    }));
    return {
      done: tag(doc, 'done') === 'true',
      status: tag(doc, 'status'),
      success: tag(doc, 'success') === 'true',
      errorMessage: tag(doc, 'errorMessage'),
      componentsDeployed: tag(doc, 'numberComponentsDeployed'),
      componentsTotal: tag(doc, 'numberComponentsTotal'),
      failures: [...failures, ...testFailures]
    };
  }
}

function tag(el, name) {
  const n = el.getElementsByTagNameNS('*', name)[0];
  return n ? n.textContent : '';
}
