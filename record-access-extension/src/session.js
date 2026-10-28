// Resolves the Salesforce API host + session id for the org open in a browser tab.
// The session id is read from the browser's existing `sid` cookie, so every API call
// runs with the permissions of the user who is currently logged in. It is never stored.

const SF_HOST = /\.(salesforce|force|salesforce-setup|cloudforce)\.com$/;

/** Map a Lightning / Setup / VF hostname to the matching My Domain API hostname. */
function toApiHost(hostname) {
  return hostname
    .replace(/\.lightning\.force\.com$/, '.my.salesforce.com')
    .replace(/\.my\.salesforce-setup\.com$/, '.my.salesforce.com')
    .replace(/--[a-z0-9]+\.vf\.force\.com$/, '.my.salesforce.com')
    .replace(/\.vf\.force\.com$/, '.my.salesforce.com');
}

async function getSid(hostname) {
  const c = await chrome.cookies.get({ url: `https://${hostname}`, name: 'sid' });
  return c ? c.value : null;
}

export async function getSession(tabUrl) {
  let url;
  try {
    url = new URL(tabUrl);
  } catch {
    throw new Error('Open a Salesforce tab first, then click the extension icon.');
  }
  if (!SF_HOST.test(url.hostname)) {
    throw new Error('The active tab is not a Salesforce page. Open your org and try again.');
  }

  // 1. Most orgs: derive the My Domain host directly.
  const apiHost = toApiHost(url.hostname);
  const directSid = await getSid(apiHost);
  if (directSid) return { host: apiHost, sid: directSid };

  // 2. Fallback: find a salesforce.com `sid` cookie that belongs to the same org
  //    (session ids start with the 15-char org id followed by "!").
  const pageSid = await getSid(url.hostname);
  if (!pageSid) throw new Error('No Salesforce session found. Log in to the org in this browser.');
  const orgId = pageSid.split('!')[0];
  const candidates = [
    ...(await chrome.cookies.getAll({ name: 'sid', domain: 'salesforce.com', secure: true })),
    ...(await chrome.cookies.getAll({ name: 'sid', domain: 'cloudforce.com', secure: true }))
  ].filter((c) => c.value.startsWith(orgId + '!'));
  candidates.sort((a, b) => Number(b.domain.includes('.my.')) - Number(a.domain.includes('.my.')));
  if (!candidates.length) {
    throw new Error('Could not find an API session for this org. Open the org via its My Domain URL and retry.');
  }
  return { host: candidates[0].domain.replace(/^\./, ''), sid: candidates[0].value };
}

/** Pull a record id out of a Lightning or Classic URL, if present. */
export function recordIdFromUrl(tabUrl) {
  if (!tabUrl) return '';
  const m =
    tabUrl.match(/\/lightning\/r\/(?:[^/]+\/)?([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)(?:\/|$|\?)/) ||
    tabUrl.match(/\.com\/([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)(?:$|\?|\/)/);
  return m ? m[1] : '';
}
