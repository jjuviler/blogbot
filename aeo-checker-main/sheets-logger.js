import crypto from 'crypto';
import https from 'https';

const COLUMNS = [
  'Timestamp', 'Checks Run', 'Plagiarism Enabled', 'Plagiarism Score',
  'Plagiarism Matches', 'Plagiarism Passed', 'Links Enabled', 'Links Total',
  'Links Broken', 'Legal Enabled', 'Legal Decision', 'Legal Topics',
  'Vague Enabled', 'Vague Flags', 'Mentions Enabled', 'Mentions Gaps',
  'Design Enabled', 'Design Flags'
];

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function makeJWT(email, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const sig = sign.sign(privateKey, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${signingInput}.${sig}`;
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method, headers };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(email, privateKey) {
  const jwt = makeJWT(email, privateKey);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  });
  if (res.status !== 200 || !res.body.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(res.body)}`);
  }
  return res.body.access_token;
}

async function logScan(entry) {
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  const email = process.env.GOOGLE_SERVICE_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!sheetId || !email || !privateKey) {
    console.warn('[sheets-logger] Missing env vars — skipping Google Sheets log.');
    return;
  }

  privateKey = privateKey.replace(/\\n/g, '\n');

  try {
    const token = await getAccessToken(email, privateKey);
    const auth = { Authorization: `Bearer ${token}` };

    // Check if the sheet tab is empty (to decide whether to write header)
    const checkRes = await request(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/ScanLog!A1:A1`,
      { headers: auth }
    );
    const isEmpty = !checkRes.body.values || checkRes.body.values.length === 0;

    const rows = [];
    if (isEmpty) rows.push(COLUMNS);

    rows.push([
      entry.timestamp        ?? new Date().toISOString(),
      entry.checksRun        ?? '',
      entry.plagiarismEnabled?? '',
      entry.plagiarismScore  ?? '',
      entry.plagiarismMatches?? '',
      entry.plagiarismPassed ?? '',
      entry.linksEnabled     ?? '',
      entry.linksTotal       ?? '',
      entry.linksBroken      ?? '',
      entry.legalEnabled     ?? '',
      entry.legalDecision    ?? '',
      entry.legalTopics      ?? '',
      entry.vagueEnabled     ?? '',
      entry.vagueFlags       ?? '',
      entry.mentionsEnabled  ?? '',
      entry.mentionsGaps     ?? '',
      entry.designEnabled    ?? '',
      entry.designFlags      ?? ''
    ]);

    const appendBody = JSON.stringify({ values: rows });
    const appendRes = await request(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/ScanLog:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(appendBody) },
        body: appendBody
      }
    );

    if (appendRes.status !== 200) {
      console.error('[sheets-logger] Append failed:', appendRes.body);
    }
  } catch (err) {
    console.error('[sheets-logger] Error:', err.message);
  }
}

export { logScan };
