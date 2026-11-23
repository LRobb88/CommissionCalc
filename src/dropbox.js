// Dropbox integration (HTTP API, no SDK).
// - Uses a long-lived refresh token (get one at /setup/dropbox).
// - Works with Dropbox team spaces: requests are rooted at the team's root
//   namespace so /PROJECTS resolves the same way it does in the desktop app.
// - When Dropbox isn't configured, files are kept on local disk (dev only).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const cfg = config.dropbox;
const enabled = () => Boolean(cfg.appKey && cfg.appSecret && cfg.refreshToken);
const LOCAL_DIR = path.join(__dirname, '..', 'data', 'uploads');

let accessToken = null;
let accessExpires = 0;
let pathRoot = undefined; // JSON string for Dropbox-API-Path-Root header

async function getAccessToken() {
  if (accessToken && Date.now() < accessExpires - 60_000) return accessToken;
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.refreshToken,
      client_id: cfg.appKey,
      client_secret: cfg.appSecret,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Dropbox token error: ${JSON.stringify(data)}`);
  accessToken = data.access_token;
  accessExpires = Date.now() + data.expires_in * 1000;
  return accessToken;
}

async function getPathRoot() {
  if (pathRoot !== undefined) return pathRoot;
  const token = await getAccessToken();
  const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const acct = await res.json();
  const ri = acct.root_info || {};
  // Team space: root namespace differs from the member's home namespace.
  pathRoot = ri.root_namespace_id && ri.root_namespace_id !== ri.home_namespace_id
    ? JSON.stringify({ '.tag': 'root', root: ri.root_namespace_id })
    : null;
  return pathRoot;
}

async function rpc(endpoint, body, { allowError } = {}) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const root = await getPathRoot();
  if (root) headers['Dropbox-API-Path-Root'] = root;
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    if (allowError && allowError(data)) return { error: data };
    throw new Error(`Dropbox ${endpoint} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return data;
}

// Dropbox header args must be ASCII-safe JSON.
function headerJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'Untitled';
}

function jobFolder(jobName) {
  return `${cfg.projectsRoot}/${safeName(jobName)}`;
}

async function ensureFolder(folderPath) {
  if (!enabled()) {
    fs.mkdirSync(path.join(LOCAL_DIR, folderPath), { recursive: true });
    return folderPath;
  }
  await rpc('files/create_folder_v2', { path: folderPath, autorename: false }, {
    // Already exists → reuse it.
    allowError: (d) => JSON.stringify(d).includes('conflict'),
  });
  return folderPath;
}

// Upload a buffer. Returns { dropbox_path } or { local_path } in dev.
async function upload(folderPath, filename, buffer) {
  const name = safeName(filename);
  if (!enabled()) {
    const dir = path.join(LOCAL_DIR, folderPath);
    fs.mkdirSync(dir, { recursive: true });
    let target = path.join(dir, name);
    if (fs.existsSync(target)) target = path.join(dir, `${crypto.randomBytes(3).toString('hex')}-${name}`);
    fs.writeFileSync(target, buffer);
    return { local_path: path.relative(LOCAL_DIR, target) };
  }
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/octet-stream',
    'Dropbox-API-Arg': headerJson({ path: `${folderPath}/${name}`, mode: 'add', autorename: true, mute: true }),
  };
  const root = await getPathRoot();
  if (root) headers['Dropbox-API-Path-Root'] = root;
  // Single-request upload handles files up to 150 MB.
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers, body: buffer });
  const data = await res.json();
  if (!res.ok) throw new Error(`Dropbox upload failed: ${JSON.stringify(data).slice(0, 300)}`);
  return { dropbox_path: data.path_display };
}

// For a pasted shared link: find the file name, and if it lives in our
// Dropbox, copy it into the job's Proofs folder so everything is in one place.
async function importSharedLink(url, destFolder) {
  if (!enabled()) return { name: decodeURIComponent((url.split('?')[0].split('/').pop() || 'proof')), dropbox_path: null };
  const meta = await rpc('sharing/get_shared_link_metadata', { url });
  const name = meta.name;
  let dropbox_path = null;
  if (meta['.tag'] === 'file' && meta.path_lower) {
    if (meta.path_lower.startsWith(destFolder.toLowerCase() + '/')) {
      dropbox_path = meta.path_lower;
    } else {
      try {
        const copied = await rpc('files/copy_v2', { from_path: meta.path_lower, to_path: `${destFolder}/${safeName(name)}`, autorename: true });
        dropbox_path = copied.metadata.path_display;
      } catch (e) {
        console.warn('Could not copy shared file into Proofs folder:', e.message);
        dropbox_path = meta.path_lower;
      }
    }
  }
  return { name, dropbox_path, mime: guessMime(name) };
}

// Returns a fetch Response-like { body (web stream), headers } for streaming a file.
async function download(file) {
  if (file.local_path) {
    const full = path.join(LOCAL_DIR, file.local_path);
    return { stream: fs.createReadStream(full), size: fs.statSync(full).size };
  }
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  const root = await getPathRoot();
  if (root) headers['Dropbox-API-Path-Root'] = root;
  let res;
  if (file.dropbox_path) {
    headers['Dropbox-API-Arg'] = headerJson({ path: file.dropbox_path });
    res = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers });
  } else if (file.link_url) {
    headers['Dropbox-API-Arg'] = headerJson({ url: file.link_url });
    res = await fetch('https://content.dropboxapi.com/2/sharing/get_shared_link_file', { method: 'POST', headers });
  } else {
    throw new Error('File has no storage location');
  }
  if (!res.ok) throw new Error(`Dropbox download failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const { Readable } = require('stream');
  return { stream: Readable.fromWeb(res.body), size: res.headers.get('content-length') };
}

// Rename/move a folder (used when a job is renamed). Fails if the target already exists.
async function moveFolder(from, to) {
  if (from === to) return;
  if (!enabled()) {
    const src = path.join(LOCAL_DIR, from), dst = path.join(LOCAL_DIR, to);
    if (fs.existsSync(dst)) throw new Error(`A folder named ${to} already exists`);
    if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(src, dst); }
    return;
  }
  const res = await rpc('files/move_v2', { from_path: from, to_path: to, autorename: false }, {
    allowError: (d) => JSON.stringify(d).includes('not_found'), // folder never created: nothing to move
  });
  if (res && res.error) return;
}

// Staff-facing link to open the job folder / file in Dropbox web.
function webUrl(dropboxPath) {
  if (!dropboxPath) return null;
  return `https://www.dropbox.com/home${dropboxPath.split('/').map(encodeURIComponent).join('/')}`;
}

function guessMime(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
    ai: 'application/postscript', eps: 'application/postscript', psd: 'image/vnd.adobe.photoshop',
  }[ext] || 'application/octet-stream';
}

module.exports = { enabled, ensureFolder, moveFolder, upload, importSharedLink, download, jobFolder, webUrl, guessMime, safeName, cfg };
