// Thin REST API client authenticated with the browser's current Salesforce session.

export class SfError extends Error {
  constructor(status, message, errorCode) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

export class SfApi {
  constructor({ host, sid }) {
    this.host = host;
    this.sid = sid;
    this.version = null;
    this.describeCache = new Map();
  }

  async request(path) {
    const res = await fetch(`https://${this.host}${path}`, {
      headers: { Authorization: `Bearer ${this.sid}`, Accept: 'application/json' },
      credentials: 'omit'
    });
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON error */
      }
      const err = Array.isArray(body) ? body[0] : body;
      const msg = err?.message || `${res.status} ${res.statusText}`;
      throw new SfError(res.status, msg, err?.errorCode);
    }
    return res.json();
  }

  async init() {
    const versions = await this.request('/services/data/');
    this.version = versions[versions.length - 1].version;
    return this;
  }

  get base() {
    return `/services/data/v${this.version}`;
  }

  /** Run SOQL and follow nextRecordsUrl so callers always get every row. */
  async query(soql) {
    let page = await this.request(`${this.base}/query?q=${encodeURIComponent(soql)}`);
    const records = [...page.records];
    while (!page.done && page.nextRecordsUrl) {
      page = await this.request(page.nextRecordsUrl);
      records.push(...page.records);
    }
    return records;
  }

  /** Run a query whose WHERE clause has an `IN ({ids})` placeholder, chunking long id lists. */
  async queryIn(soqlTemplate, ids, chunkSize = 200) {
    const unique = [...new Set(ids)];
    const out = [];
    for (let i = 0; i < unique.length; i += chunkSize) {
      const list = unique.slice(i, i + chunkSize).map((id) => `'${id}'`).join(',');
      out.push(...(await this.query(soqlTemplate.replace('{ids}', list))));
    }
    return out;
  }

  async describeGlobal() {
    if (!this.global) this.global = await this.request(`${this.base}/sobjects/`);
    return this.global;
  }

  async describe(sobject) {
    if (!this.describeCache.has(sobject)) {
      this.describeCache.set(sobject, this.request(`${this.base}/sobjects/${sobject}/describe`));
    }
    return this.describeCache.get(sobject);
  }

  /** Who is logged in (the identity whose permissions the checks run under). */
  async currentUser() {
    try {
      const me = await this.request(`${this.base}/chatter/users/me`);
      return { id: me.id, name: me.name, username: me.username };
    } catch {
      try {
        const info = await this.request('/services/oauth2/userinfo');
        return { id: info.user_id, name: info.name, username: info.preferred_username };
      } catch {
        return null;
      }
    }
  }
}
