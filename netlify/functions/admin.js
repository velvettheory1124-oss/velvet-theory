'use strict';
/*
  Owner-only publishing for VELVET/THEORY, running as a Netlify Function.

  The editor on the live site sends its changes here; this commits them to the
  GitHub repository, and Netlify redeploys from that commit. No computer, no
  Python and no Git are needed on the editing side.

  Three actions, all POSTed as JSON to /.netlify/functions/admin:
    ping     { }                                  -> is this set up?
    login    { password }                         -> { token }  (valid 12 hours)
    upload   { token, name, data }                -> { sha }    one photo (base64 JPEG)
    publish  { token, content, files, baseV,
               message }                          -> { commit, v }

  Settings (Netlify > Site configuration > Environment variables):
    ADMIN_PASSWORD   the password you type to log in (at least 10 characters:
                     whoever has it can change the public site)
    GITHUB_TOKEN     fine-grained token with Contents: read & write on the repo
    SESSION_SECRET   optional; signs the login token. Left out, it is derived
                     from the two above, so changing the password also logs
                     everyone out.
    GITHUB_REPO      optional, default velvettheory1124-oss/velvet-theory
    GITHUB_BRANCH    optional, default main

  Nothing here can be reached without the password: every action except ping
  and login needs a valid signed token, and the GitHub token never leaves the
  server.
*/
const crypto = require('crypto');

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const REPO = process.env.GITHUB_REPO || 'velvettheory1124-oss/velvet-theory';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_PHOTO = 3.5 * 1024 * 1024;           // decoded bytes; a function accepts ~6 MB per request
const ALLOWED_KEYS = ['layouts', 'removed', 'added', 'caps', 'adj', 'covers', 'subs', 'groups'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,80}\.jpg$/;
const SHA_RE = /^[0-9a-f]{40}$/;

const reply = (status, obj) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});
const fail = (status, error) => { const e = new Error(error); e.status = status; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MIN_PASSWORD = 10;

const configured = () =>
  !!(process.env.ADMIN_PASSWORD && process.env.GITHUB_TOKEN);
const passwordOk = () => String(process.env.ADMIN_PASSWORD || '').length >= MIN_PASSWORD;

/* ---------------------------------------------------------------- login */

const digest = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const secret = () => process.env.SESSION_SECRET ||
  crypto.createHash('sha256')
    .update('vt-session|' + process.env.GITHUB_TOKEN + '|' + process.env.ADMIN_PASSWORD).digest('hex');
const hmac = payload =>
  crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MS })).toString('base64url');
  return payload + '.' + hmac(payload);
}

function tokenOk(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 1) return false;
  const [payload, sig] = token.split('.');
  let good;
  try { good = hmac(payload); } catch (e) { return false; }
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); }
  catch (e) { return false; }
}

/* ---------------------------------------------------------------- GitHub */

async function gh(path, opts = {}) {
  const r = await fetch(API + path, {
    method: opts.method || 'GET',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers: Object.assign({
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'velvet-theory-admin',
      'Content-Type': 'application/json',
    }, opts.headers || {}),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch (e) { /* keep text */ }
    const err = new Error('GitHub: ' + String(msg).slice(0, 200));
    err.status = r.status;
    err.github = true;
    throw err;
  }
  if (opts.raw) return text;
  return text ? JSON.parse(text) : {};
}

/* ---------------------------------------------------------------- the page */

/* Find the whole `const BASE_CONTENT = {...};` statement. Braces inside strings
   are skipped, so a caption such as "a } b" cannot throw the match off. */
function findStatement(html) {
  const m = /^[ \t]*const BASE_CONTENT = /m.exec(html);
  if (!m) throw fail(500, 'Could not find BASE_CONTENT in the page.');
  const open = html.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, inStr = false, quote = '', esc = false, j = open;
  for (; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
    } else if (c === '"' || c === "'") { inStr = true; quote = c; }
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  if (j >= html.length) throw fail(500, 'BASE_CONTENT in the page is not closed.');
  let k = j + 1;
  while (html[k] === ' ' || html[k] === '\t') k++;
  if (html[k] === ';') k++;
  return { start: m.index, end: k, text: html.slice(m.index, k) };
}

function renderStatement(content, nl) {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);   // not allowed raw inside a script
  const text = JSON.stringify(content, null, 1)
    .replace(/<\//g, '<\\/')                      // a caption can never end the page's script
    .split(LS).join('\\u2028').split(PS).join('\\u2029');
  return ('const BASE_CONTENT = ' + text + ';').split('\n').join(nl);
}

/* What the editor may send. This is the page's own data, and some of it is
   later written into the page as HTML, so it is checked here too: no tag
   characters anywhere, and anything that names a file must look like one. */
const FILE_RE = /^(images\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
function checkContent(content) {
  const bad = why => { throw fail(400, why); };
  const walk = (v, path) => {
    if (typeof v === 'string') {
      if (/[<>]/.test(v)) bad('"<" and ">" are not allowed in text (' + path + '). Remove them and publish again.');
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + '[' + i + ']'));
    else if (v && typeof v === 'object') Object.keys(v).forEach(k => { walk(k, path); walk(v[k], path + '.' + k); });
  };
  walk(content, 'content');
  const file = (f, where) => { if (typeof f !== 'string' || !FILE_RE.test(f)) bad('An invalid photo name was found (' + where + ').'); };
  Object.keys(content.covers || {}).forEach(k => file(content.covers[k], 'covers.' + k));
  Object.keys(content.removed || {}).forEach(k => (content.removed[k] || []).forEach(f => file(f, 'removed.' + k)));
  Object.keys(content.added || {}).forEach(k => (content.added[k] || []).forEach(a => file(a && a[0], 'added.' + k)));
  Object.keys(content.layouts || {}).forEach(k => {
    const L = content.layouts[k] || {};
    (L.order || []).forEach(col => (col || []).forEach(f => file(f, 'layouts.' + k)));
  });
  Object.keys(content.groups || {}).forEach(k => {
    const g = content.groups[k];
    if (g) (g.shots || []).forEach(s => file(s && s[0], 'groups.' + k));
  });
  Object.keys(content.adj || {}).forEach(f => file(f, 'adj'));
  Object.keys(content.caps || {}).forEach(f => file(f, 'caps'));
}

/* ---------------------------------------------------------------- actions */

async function upload(body) {
  const name = String(body.name || '');
  if (!NAME_RE.test(name)) throw fail(400, 'That photo name is not allowed.');
  let raw;
  try { raw = Buffer.from(String(body.data || ''), 'base64'); } catch (e) { raw = Buffer.alloc(0); }
  if (raw.length < 4 || raw[0] !== 0xff || raw[1] !== 0xd8) throw fail(400, name + ' is not a JPEG.');
  if (raw.length > MAX_PHOTO) throw fail(413, name + ' is too large (' + Math.round(raw.length / 1024) + ' KB).');
  const blob = await gh('/repos/' + REPO + '/git/blobs', {
    method: 'POST', body: { content: raw.toString('base64'), encoding: 'base64' },
  });
  return { ok: true, sha: blob.sha };
}

async function publish(body) {
  const content = body.content;
  if (!content || typeof content !== 'object' || Array.isArray(content) ||
      !Object.keys(content).every(k => ALLOWED_KEYS.includes(k))) {
    throw fail(400, 'The editor sent something this site does not recognise.');
  }
  checkContent(content);
  const files = Array.isArray(body.files) ? body.files : [];
  for (const f of files) {
    if (!f || !NAME_RE.test(String(f.name)) || !SHA_RE.test(String(f.sha))) throw fail(400, 'A photo reference was invalid.');
  }
  const message = String(body.message || '').trim().slice(0, 200) ||
    ('Update the site - ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC');

  // where the site is right now
  const ref = await gh('/repos/' + REPO + '/git/ref/heads/' + BRANCH);
  const headSha = ref.object.sha;
  const head = await gh('/repos/' + REPO + '/git/commits/' + headSha);
  const html = await gh('/repos/' + REPO + '/contents/V2-PORTFOLIO.html?ref=' + headSha, {
    raw: true, headers: { Accept: 'application/vnd.github.raw+json' },
  });

  // Refuse to overwrite someone else's publish: the editor must have loaded the
  // version that is on the site now.
  const stmt = findStatement(html);
  const current = (/"_v":\s*(\d+)/.exec(stmt.text) || [])[1] || '';
  if (current !== String(body.baseV || '')) {
    throw fail(409, 'The site was published by someone else since you opened it. Reload the page and publish again — your edits in this browser are kept.');
  }

  // a new photograph must never silently replace one that is already published
  if (files.length) {
    const have = await gh('/repos/' + REPO + '/git/trees/' + head.tree.sha + '?recursive=1');
    const existing = new Map((have.tree || []).map(t => [t.path, t.sha]));
    for (const f of files) {
      const old = existing.get('images/' + f.name);
      if (old && old !== f.sha) throw fail(409, 'A different photo called ' + f.name + ' is already on the site. Rename the new one and publish again.');
    }
  }

  const v = Date.now();
  const nl = html.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const next = html.slice(0, stmt.start) + renderStatement(Object.assign({ _v: v }, content), nl) + html.slice(stmt.end);
  const page = await gh('/repos/' + REPO + '/git/blobs', { method: 'POST', body: { content: next, encoding: 'utf-8' } });

  // the page, its published copy, and every new photo (working copy + published copy)
  const entry = (path, sha) => ({ path, mode: '100644', type: 'blob', sha });
  const tree = [entry('V2-PORTFOLIO.html', page.sha), entry('PUBLISH/index.html', page.sha)];
  files.forEach(f => {
    tree.push(entry('images/' + f.name, f.sha));
    tree.push(entry('PUBLISH/images/' + f.name, f.sha));
  });
  const newTree = await gh('/repos/' + REPO + '/git/trees', { method: 'POST', body: { base_tree: head.tree.sha, tree } });
  const commit = await gh('/repos/' + REPO + '/git/commits', {
    method: 'POST', body: { message, tree: newTree.sha, parents: [headSha] },
  });
  try {
    await gh('/repos/' + REPO + '/git/refs/heads/' + BRANCH, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  } catch (e) {
    if (e.status === 422 || e.status === 409) {
      throw fail(409, 'The site changed while you were publishing. Reload the page and publish again — your edits in this browser are kept.');
    }
    throw e;
  }
  return { ok: true, commit: commit.sha.slice(0, 7), v };
}

/* ---------------------------------------------------------------- entry */

exports.handler = async event => {
  try {
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'POST only.' });

    // only the site itself may call this; another website's page is refused
    const origin = event.headers.origin || event.headers.Origin;
    const host = event.headers.host || event.headers.Host;
    if (origin) {
      let oh = '';
      try { oh = new URL(origin).host; } catch (e) { /* refused below */ }
      if (oh !== host) return reply(403, { ok: false, error: 'Refused: wrong origin.' });
    }

    let body;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
      body = JSON.parse(raw || '{}');
    } catch (e) { return reply(400, { ok: false, error: 'Could not read the request.' }); }

    if (body.action === 'ping') return reply(200, { ok: true, configured: configured() && passwordOk() });
    if (!configured()) return reply(503, { ok: false, error: 'Owner login is not set up on this site yet.' });
    if (!passwordOk()) return reply(503, { ok: false, error: 'Owner login is switched off: the ADMIN_PASSWORD set in Netlify is shorter than ' + MIN_PASSWORD + ' characters. Set a longer one.' });

    if (body.action === 'login') {
      if (typeof body.password === 'string' && safeEqual(body.password, process.env.ADMIN_PASSWORD)) {
        return reply(200, { ok: true, token: makeToken() });
      }
      await sleep(1000);                                     // makes guessing slow
      return reply(401, { ok: false, error: 'Incorrect password.' });
    }

    if (!tokenOk(body.token)) return reply(401, { ok: false, error: 'Please log in again.' });

    if (body.action === 'upload') return reply(200, await upload(body));
    if (body.action === 'publish') return reply(200, await publish(body));
    return reply(400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 && !e.github ? e.status : (e.github ? 502 : 500);
    return reply(status, { ok: false, error: e.message || 'Unexpected error.' });
  }
};

exports._internal = { findStatement, renderStatement, checkContent };
