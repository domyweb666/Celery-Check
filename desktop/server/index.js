// 芹查：電腦端伺服器
// - 手機的螢幕廣播擴充用 WebSocket 推 JPEG 畫面進來（/ingest）
// - 伺服器一直保留最近幾十秒的畫面，按「標記」時切成片段存檔
// - 瀏覽器介面（只限本機）看即時畫面、框選、寫回報
// - 回報存成檔案，Claude Code 透過 MCP（server/mcp.js）讀取
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import {
  ROOT,
  DATA_DIR,
  clipDir,
  noteDir,
  loadConfig,
  saveConfig,
  listClips,
  getClip,
  deleteClip,
  listNotes,
  getNote,
  createNote,
  updateNoteStatus,
  deleteNote,
  saveNote,
  noteToText,
  writeJSON,
  readJSON,
  stamp,
  safeId,
  takeSessionNumber,
} from './store.js';

const WEB_DIR = path.join(ROOT, 'web');
const MAX_CLIPS = 20; // 最多留幾場測試
let config = loadConfig();

// ---------------------------------------------------------------------------
// 手機畫面：滾動緩衝
// ---------------------------------------------------------------------------

/** @type {{t:number, buf:Buffer, w:number, h:number}[]} */
let ring = [];
let latest = null; // 最新一格
const phone = {
  socket: null,
  connected: false,
  device: '',
  model: '',
  connectedAt: 0,
  lastFrameAt: 0,
  width: 0,
  height: 0,
  frameTimes: [], // 算每秒幾格
  received: 0,
};

/** 正在寫入的片段：標記後的「後續幾秒」或手動錄影 */
const activeCaptures = new Map(); // id -> { id, dir, frames, until, kind, timer }

// 從 JPEG 裡讀寬高（SOFn 區段）
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function onPhoneFrame(data) {
  // 格式：前 8 位元組是毫秒時間戳（big-endian），後面是 JPEG
  if (data.length < 12) return;
  let t = Number(data.readBigUInt64BE(0));
  const buf = data.subarray(8);
  const now = Date.now();
  // 手機和電腦時鐘可能差一點；差太多就用電腦時間
  if (!Number.isFinite(t) || Math.abs(t - now) > 5000) t = now;
  if (latest && t <= latest.t) t = latest.t + 1;

  const size = jpegSize(buf) || { w: phone.width, h: phone.height };
  const frame = { t, buf: Buffer.from(buf), w: size.w, h: size.h };
  latest = frame;
  phone.lastFrameAt = now;
  phone.width = size.w;
  phone.height = size.h;
  phone.received++;
  phone.frameTimes.push(now);
  while (phone.frameTimes.length && phone.frameTimes[0] < now - 2000) phone.frameTimes.shift();

  ring.push(frame);
  const keepFrom = t - config.bufferSeconds * 1000;
  let drop = 0;
  while (drop < ring.length && ring[drop].t < keepFrom) drop++;
  if (drop) ring = ring.slice(drop);

  for (const cap of activeCaptures.values()) appendFrame(cap, frame);
  for (const cap of [...activeCaptures.values()]) {
    if (cap.until && t >= cap.until) finishCapture(cap.id);
  }
  pushFrameToBrowsers(frame);
}

function phoneStatus() {
  const now = Date.now();
  const recent = phone.frameTimes.filter((x) => x > now - 2000).length;
  return {
    connected: phone.connected,
    device: phone.device,
    model: phone.model,
    fps: Math.round((recent / 2) * 10) / 10,
    width: phone.width,
    height: phone.height,
    lastFrameAt: phone.lastFrameAt,
    lastFrameAge: phone.lastFrameAt ? now - phone.lastFrameAt : null,
  };
}

// ---------------------------------------------------------------------------
// 片段
// ---------------------------------------------------------------------------

function newClipId() {
  let id = stamp();
  let n = 1;
  while (fs.existsSync(clipDir(id))) id = `${stamp()}-${++n}`;
  return id;
}

function appendFrame(cap, frame) {
  if (cap.frames.length && frame.t <= cap.frames[cap.frames.length - 1].t) return;
  const f = `${String(cap.frames.length + 1).padStart(6, '0')}.jpg`;
  fs.writeFileSync(path.join(cap.dir, 'frames', f), frame.buf);
  cap.frames.push({ f, t: frame.t });
  if (!cap.w) {
    cap.w = frame.w;
    cap.h = frame.h;
  }
  // 錄影中每 60 格存一次清單，當機也不會全丟
  if (cap.frames.length % 60 === 0) writeJSON(path.join(cap.dir, 'frames.json'), cap.frames);
}

// 開始一場測試：整段錄起來，直到按「結束測試」或手機斷線
function startSession({ preMs, project = '' }) {
  const id = newClipId();
  const dir = clipDir(id);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  const now = Date.now();
  const cap = {
    id,
    dir,
    kind: 'session',
    number: takeSessionNumber(),
    project,
    frames: [],
    markers: [],
    label: '',
    keep: false,
    w: 0,
    h: 0,
    createdAt: now,
  };
  const from = now - preMs;
  for (const fr of ring) if (fr.t >= from) appendFrame(cap, fr);
  // 畫面靜止時手機不會送新格；把最後一格補進來，至少有一張
  if (!cap.frames.length && latest) appendFrame(cap, latest);
  activeCaptures.set(id, cap);
  if (project) config = saveConfig({ lastProject: project });
  const meta = writeClipMeta(cap, 'capturing');
  broadcast({ type: 'clip', clip: meta });
  return cap;
}

function addMarker(cap) {
  const t = latest ? latest.t : Date.now();
  // 一秒內連按兩次（例如踏板彈跳）只算一次
  const last = cap.markers[cap.markers.length - 1];
  if (last && Math.abs(last.t - t) < 800) return cap.markers.length - 1;
  cap.markers.push({ t, at: Date.now() });
  const meta = writeClipMeta(cap, 'capturing');
  broadcast({ type: 'marker', clip: meta });
  return cap.markers.length - 1;
}

function writeClipMeta(cap, status) {
  writeJSON(path.join(cap.dir, 'frames.json'), cap.frames);
  const meta = {
    id: cap.id,
    kind: cap.kind,
    number: cap.number,
    project: cap.project,
    label: cap.label,
    keep: !!cap.keep,
    status,
    createdAt: cap.createdAt,
    frameCount: cap.frames.length,
    width: cap.w,
    height: cap.h,
    start: cap.frames[0]?.t ?? cap.createdAt,
    end: cap.frames[cap.frames.length - 1]?.t ?? cap.createdAt,
    markers: cap.markers,
    thumb: thumbFrame(cap),
    device: phone.device,
  };
  writeJSON(path.join(cap.dir, 'meta.json'), meta);
  return meta;
}

// 縮圖：有書籤用第一個書籤那格，沒有就用中間
function thumbFrame(cap) {
  if (!cap.frames.length) return null;
  const t = cap.markers?.[0]?.t;
  if (t) {
    let best = cap.frames[0];
    for (const fr of cap.frames) if (fr.t <= t) best = fr;
    return best.f;
  }
  return cap.frames[Math.floor(cap.frames.length / 2)].f;
}

function finishCapture(id) {
  const cap = activeCaptures.get(id);
  if (!cap) return null;
  activeCaptures.delete(id);
  const meta = writeClipMeta(cap, 'ready');
  broadcast({ type: 'clip', clip: meta });
  pruneClips();
  return meta;
}

function activeSession() {
  for (const cap of activeCaptures.values()) if (cap.kind === 'session') return cap;
  return null;
}

function sessionSummary(cap) {
  if (!cap) return null;
  return { id: cap.id, number: cap.number, project: cap.project, startedAt: cap.createdAt, frames: cap.frames.length, markers: cap.markers.length };
}

// 舊的場次自動清掉（勾「保留」的、還有草稿沒送出的不刪）
function pruneClips() {
  const clips = listClips().filter((c) => c.status === 'ready' && !c.keep);
  let kept = 0;
  for (const c of clips) {
    const drafts = readJSON(path.join(clipDir(c.id), 'drafts.json'), []);
    const pending = drafts.some((d) => !d.noteId && (d.description || d.annotations?.length));
    if (pending) continue;
    if (++kept > MAX_CLIPS) deleteClip(c.id);
  }
}

// 用 ffmpeg 把片段轉成 mp4（有裝 ffmpeg 才能用）
let ffmpegOk = null;
function hasFfmpeg() {
  if (ffmpegOk === null) {
    try {
      ffmpegOk = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0;
    } catch {
      ffmpegOk = false;
    }
  }
  return ffmpegOk;
}

function exportClipMp4(id) {
  return new Promise((resolve, reject) => {
    const clip = getClip(id);
    if (!clip || !clip.frames.length) return reject(new Error('片段是空的'));
    if (!hasFfmpeg()) return reject(new Error('這台電腦沒有 ffmpeg，裝好後重開芹查就能匯出影片'));
    const dir = clipDir(id);
    const list = [];
    clip.frames.forEach((fr, i) => {
      const next = clip.frames[i + 1];
      const dur = next ? Math.max(0.001, (next.t - fr.t) / 1000) : 0.5;
      list.push(`file 'frames/${fr.f}'`, `duration ${dur.toFixed(3)}`);
    });
    list.push(`file 'frames/${clip.frames[clip.frames.length - 1].f}'`);
    fs.writeFileSync(path.join(dir, 'ffconcat.txt'), list.join('\n'));
    const out = path.join(dir, 'clip.mp4');
    const p = spawn(
      'ffmpeg',
      ['-y', '-f', 'concat', '-safe', '0', '-i', 'ffconcat.txt', '-fps_mode', 'vfr', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', 'clip.mp4'],
      { cwd: dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffmpeg 失敗：${err.split('\n').slice(-3).join(' ')}`))));
  });
}

// ---------------------------------------------------------------------------
// 網路與配對
// ---------------------------------------------------------------------------

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      if (n.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|WSL|VirtualBox|VMware|Hyper-V|Docker|vboxnet|utun|Loopback|Tailscale|ZeroTier/i.test(name);
      let score = 0;
      if (n.address.startsWith('192.168.')) score += 3;
      else if (n.address.startsWith('10.')) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(n.address)) score += 1;
      if (/wi-?fi|wlan|無線|wireless/i.test(name)) score += 2;
      if (/ethernet|乙太|eth|en\d/i.test(name)) score += 1;
      if (virtual) score -= 10;
      out.push({ name, address: n.address, score, virtual });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function pcName() {
  return config.pcName || os.hostname();
}

function pairUrl(address) {
  const q = new URLSearchParams({ h: address, p: String(config.port), t: config.token, n: pcName() });
  return `celerycheck://pair?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// 瀏覽器即時連線
// ---------------------------------------------------------------------------

const liveClients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of liveClients) if (ws.readyState === 1) ws.send(msg);
}

function pushFrameToBrowsers(frame) {
  for (const ws of liveClients) {
    if (ws.readyState !== 1) continue;
    // 瀏覽器來不及吃就跳格，不要越積越多
    if (ws.bufferedAmount > 2 * 1024 * 1024) continue;
    ws.send(frame.buf, { binary: true });
  }
}

setInterval(() => {
  broadcast({ type: 'status', phone: phoneStatus(), session: sessionSummary(activeSession()) });
}, 1000);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
};

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(data);
}

function sendFile(res, file, extra = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: '找不到檔案' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      ...extra,
    });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('資料太大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('不是 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function claudePrompt(note) {
  // 給 Claude Code 的開場訊息。啟動新視窗用的版本只用英數字，避免 Windows 命令列編碼出錯。
  return {
    zh: `請用芹查的 MCP 工具處理回報 #${note.number}：先用 celery_get_note 讀取（id: ${note.id}），看圖找出問題、修正程式碼，修好後用 celery_mark_fixed 寫下你改了什麼。`,
    ascii: `Use the celery-check MCP tools: read report #${note.number} with celery_get_note (id ${note.id}), fix the code, then call celery_mark_fixed with a summary in Traditional Chinese. Reply to me in Traditional Chinese.`,
  };
}

function allOpenPrompt(project, session) {
  const meta = session ? readJSON(path.join(clipDir(safeId(session)), 'meta.json'), null) : null;
  const scope = meta ? `第 ${meta.number} 場測試的` : project ? `「${project}」的` : '';
  const arg = meta ? `（session: ${meta.id}）` : '';
  return {
    zh: `請用芹查的 MCP 工具處理${scope}所有待修回報：先用 celery_list_notes${arg} 列出來，再逐筆用 celery_get_note 讀取、修正，每修好一筆就用 celery_mark_fixed 寫下改了什麼。全部改完再一起 commit。`,
    ascii: `Use the celery-check MCP tools: list open reports with celery_list_notes${meta ? ` (session "${meta.id}")` : ''}, then read each with celery_get_note, fix it, and call celery_mark_fixed with a summary in Traditional Chinese. Commit once after all fixes. Reply to me in Traditional Chinese.`,
  };
}

function launchClaude(localPath, prompt, title) {
  if (process.platform !== 'win32') throw new Error('自動開啟 Claude Code 只支援 Windows；請改用「複製給 Claude」');
  if (!localPath || !fs.existsSync(localPath)) throw new Error('這個專案還沒設定電腦上的資料夾，或資料夾不存在（到「設定」填寫）');
  const safeTitle = String(title).replace(/["^&|<>%]/g, '');
  const safePrompt = prompt.replace(/["^&|<>%]/g, '');
  const cmd = `/c start "${safeTitle}" /D "${localPath}" cmd /k claude "${safePrompt}"`;
  const p = spawn('cmd.exe', [cmd], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' });
  p.unref();
}

function projectByName(name) {
  return (config.projects || []).find((p) => p.name === name) || null;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  // ---- 手機可呼叫（要帶配對碼） ----
  if (p === '/api/ping') {
    if (url.searchParams.get('t') !== config.token) return send(res, 403, { ok: false, error: '配對碼不對，請重新掃描 QR code' });
    return send(res, 200, { ok: true, name: pcName(), streaming: phone.connected });
  }

  if (!isLocal(req)) return send(res, 403, { error: '只能在這台電腦上使用' });

  // ---- 以下只限本機 ----
  if (p === '/api/state' && m === 'GET') {
    return send(res, 200, {
      phone: phoneStatus(),
      session: sessionSummary(activeSession()),
      config: { ...config },
      ffmpeg: hasFfmpeg(),
      platform: process.platform,
      dataDir: DATA_DIR,
      mcpCommand: `claude mcp add celery-check --scope user -- node "${path.join(ROOT, 'server', 'mcp.js')}"`,
    });
  }

  if (p === '/api/pair' && m === 'GET') {
    const addrs = lanAddresses();
    const chosen = url.searchParams.get('ip') || addrs[0]?.address || '127.0.0.1';
    const link = pairUrl(chosen);
    const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return send(res, 200, { addresses: addrs, chosen, url: link, svg, port: config.port, name: pcName() });
  }

  if (p === '/api/config' && m === 'PUT') {
    const body = await readBody(req);
    const allowed = ['pcName', 'preSeconds', 'bufferSeconds', 'markKeys', 'recordKeys', 'openReviewAfterMark', 'projects', 'lastProject'];
    const patch = {};
    for (const k of allowed) if (k in body) patch[k] = body[k];
    if ('preSeconds' in patch) patch.preSeconds = Math.min(60, Math.max(1, Number(patch.preSeconds) || 20));
    patch.bufferSeconds = Math.max(Number(patch.preSeconds ?? config.preSeconds) + 10, Number(patch.bufferSeconds ?? config.bufferSeconds) || 40);
    if (Array.isArray(patch.projects)) {
      patch.projects = patch.projects
        .map((x) => ({ name: String(x.name || '').trim(), repo: String(x.repo || '').trim(), localPath: String(x.localPath || '').trim() }))
        .filter((x) => x.name);
    }
    config = saveConfig(patch);
    return send(res, 200, { ok: true, config });
  }

  if (p === '/api/config/new-token' && m === 'POST') {
    config = saveConfig({ token: '' });
    config = loadConfig();
    if (phone.socket) phone.socket.close(4001, 'token changed');
    return send(res, 200, { ok: true });
  }

  if (p === '/api/screenshot' && m === 'GET') {
    if (!latest) return send(res, 404, { error: '手機還沒連上，沒有畫面' });
    return send(res, 200, latest.buf, 'image/jpeg', {
      'X-Frame-Time': String(latest.t),
      'X-Frame-Age': String(Date.now() - latest.t),
      'X-Phone-Connected': phone.connected ? '1' : '0',
    });
  }

  // ---- 測試場次 ----
  if (p === '/api/session/start' && m === 'POST') {
    const body = await readBody(req);
    const existing = activeSession();
    if (existing) return send(res, 200, { ok: true, session: sessionSummary(existing), already: true });
    if (!latest) return send(res, 409, { error: '手機還沒連上，沒有畫面可以錄' });
    const cap = startSession({ preMs: 3000, project: String(body.project ?? config.lastProject ?? '') });
    return send(res, 200, { ok: true, session: sessionSummary(cap) });
  }

  // 書籤：測試中按 F8／踏板。還沒開始測試的話，自動開始一場，並把前幾十秒補進來
  if (p === '/api/session/marker' && m === 'POST') {
    if (!latest) return send(res, 409, { error: '手機還沒連上，沒有畫面可以標記' });
    let cap = activeSession();
    let started = false;
    if (!cap) {
      cap = startSession({ preMs: config.preSeconds * 1000, project: config.lastProject || '' });
      started = true;
    }
    const index = addMarker(cap);
    return send(res, 200, { ok: true, session: sessionSummary(cap), markerIndex: index, started });
  }

  if (p === '/api/session/stop' && m === 'POST') {
    const cap = activeSession();
    if (!cap) return send(res, 200, { ok: true, clipId: null });
    const meta = finishCapture(cap.id);
    return send(res, 200, { ok: true, clipId: meta?.id });
  }

  // ---- 片段 ----
  if (p === '/api/clips' && m === 'GET') {
    // 順便算每場的草稿和已送出數量
    const clips = listClips().map((c) => {
      const drafts = readJSON(path.join(clipDir(c.id), 'drafts.json'), []);
      const live = activeCaptures.get(c.id);
      return {
        ...c,
        ...(live ? { frameCount: live.frames.length, end: live.frames[live.frames.length - 1]?.t ?? c.end, markers: live.markers } : {}),
        draftCount: drafts.filter((d) => !d.noteId).length,
        sentCount: drafts.filter((d) => d.noteId).length,
      };
    });
    return send(res, 200, clips);
  }

  let mm;
  if ((mm = /^\/api\/clips\/([^/]+)$/.exec(p))) {
    const id = safeId(mm[1]);
    if (m === 'GET') {
      const live = activeCaptures.get(id);
      if (live) {
        const meta = readJSON(path.join(clipDir(id), 'meta.json'), {});
        return send(res, 200, { ...meta, status: 'capturing', project: live.project, markers: live.markers, frames: live.frames, frameCount: live.frames.length });
      }
      const clip = getClip(id);
      return clip ? send(res, 200, clip) : send(res, 404, { error: '找不到這場測試' });
    }
    if (m === 'DELETE') {
      if (activeCaptures.has(id)) return send(res, 409, { error: '這場測試還在錄，先按「結束測試」' });
      deleteClip(id);
      return send(res, 200, { ok: true });
    }
    if (m === 'PATCH') {
      const body = await readBody(req);
      const cap = activeCaptures.get(id);
      const metaPath = path.join(clipDir(id), 'meta.json');
      const meta = cap || readJSON(metaPath, null);
      if (!meta) return send(res, 404, { error: '找不到這場測試' });
      if ('keep' in body) meta.keep = !!body.keep;
      if ('label' in body) meta.label = String(body.label).slice(0, 60);
      if ('project' in body) {
        meta.project = String(body.project);
        config = saveConfig({ lastProject: meta.project });
      }
      if (Array.isArray(body.markers)) meta.markers = body.markers.filter((x) => Number.isFinite(x?.t)).map((x) => ({ t: x.t, at: x.at || x.t }));
      if (cap) return send(res, 200, writeClipMeta(cap, 'capturing'));
      writeJSON(metaPath, meta);
      broadcast({ type: 'clip', clip: meta });
      return send(res, 200, meta);
    }
  }

  // 草稿：排查時寫到一半的標註和說明，存在伺服器上，關掉瀏覽器也不會不見
  if ((mm = /^\/api\/clips\/([^/]+)\/drafts$/.exec(p))) {
    const file = path.join(clipDir(safeId(mm[1])), 'drafts.json');
    if (m === 'GET') return send(res, 200, readJSON(file, []));
    if (m === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body)) return send(res, 400, { error: '格式不對' });
      if (!fs.existsSync(path.dirname(file))) return send(res, 404, { error: '找不到這場測試' });
      writeJSON(file, body);
      return send(res, 200, { ok: true });
    }
  }

  if ((mm = /^\/api\/clips\/([^/]+)\/export$/.exec(p)) && m === 'POST') {
    const out = await exportClipMp4(safeId(mm[1]));
    return send(res, 200, { ok: true, url: `/clips/${mm[1]}/clip.mp4`, path: out });
  }

  // ---- 回報 ----
  if (p === '/api/notes' && m === 'GET') {
    let notes = listNotes();
    const status = url.searchParams.get('status');
    const project = url.searchParams.get('project');
    if (status && status !== 'all') {
      const set = new Set(status.split(','));
      notes = notes.filter((n) => set.has(n.status));
    }
    if (project) notes = notes.filter((n) => (n.project || '') === project);
    const session = url.searchParams.get('session');
    if (session) notes = notes.filter((n) => n.clipId === session);
    return send(res, 200, notes);
  }

  if (p === '/api/notes' && m === 'POST') {
    const body = await readBody(req);
    if (!String(body.description || '').trim() && !(body.annotations || []).length) {
      return send(res, 400, { error: '請至少畫一個標註或寫一句說明' });
    }
    const clip = body.clipId ? readJSON(path.join(clipDir(safeId(body.clipId)), 'meta.json'), null) : null;
    const note = createNote({ ...body, sessionNumber: clip?.number ?? null, project: body.project ?? clip?.project ?? '' });
    if (!body.quiet) broadcast({ type: 'notes-changed' });
    return send(res, 200, { ok: true, note, prompt: claudePrompt(note).zh });
  }

  if (p === '/api/notes/prompt-all' && m === 'GET') {
    const project = url.searchParams.get('project') || '';
    const session = url.searchParams.get('session') || '';
    return send(res, 200, { prompt: allOpenPrompt(project, session).zh });
  }

  if (p === '/api/notes/launch-all' && m === 'POST') {
    const body = await readBody(req);
    const proj = projectByName(body.project);
    launchClaude(proj?.localPath, allOpenPrompt(body.project, body.session).ascii, `Celery-Check ${body.project || ''}`);
    return send(res, 200, { ok: true });
  }

  if ((mm = /^\/api\/notes\/([^/]+)$/.exec(p))) {
    const id = safeId(mm[1]);
    if (m === 'GET') {
      const note = getNote(id);
      if (!note) return send(res, 404, { error: '找不到回報' });
      return send(res, 200, { ...note, text: noteToText(note), prompt: claudePrompt(note).zh });
    }
    if (m === 'PATCH') {
      const body = await readBody(req);
      let note = getNote(id);
      if (!note) return send(res, 404, { error: '找不到回報' });
      if ('title' in body || 'description' in body || 'project' in body || 'severity' in body) {
        if ('title' in body) note.title = String(body.title).slice(0, 80);
        if ('description' in body) note.description = String(body.description);
        if ('project' in body) note.project = String(body.project);
        if ('severity' in body && ['小', '中', '大'].includes(body.severity)) note.severity = body.severity;
        note = saveNote(note);
      }
      if (body.status || body.comment || body.afterImage) {
        note = updateNoteStatus(id, { status: body.status, text: body.comment || '', afterImage: body.afterImage, by: '多米' });
      }
      broadcast({ type: 'notes-changed' });
      return send(res, 200, note);
    }
    if (m === 'DELETE') {
      deleteNote(id);
      broadcast({ type: 'notes-changed' });
      return send(res, 200, { ok: true });
    }
  }

  if ((mm = /^\/api\/notes\/([^/]+)\/launch$/.exec(p)) && m === 'POST') {
    const note = getNote(safeId(mm[1]));
    if (!note) return send(res, 404, { error: '找不到回報' });
    const proj = projectByName(note.project);
    launchClaude(proj?.localPath, claudePrompt(note).ascii, `Celery-Check #${note.number}`);
    return send(res, 200, { ok: true });
  }

  // MCP 改了回報後通知介面重新整理
  if (p === '/api/notify' && m === 'POST') {
    broadcast({ type: 'notes-changed' });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: `沒有這個 API：${m} ${p}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (!isLocal(req)) {
      return send(res, 200, '<meta charset="utf-8"><p>芹查伺服器正在執行。請在電腦上打開 http://localhost:' + config.port + '</p>', 'text/html; charset=utf-8');
    }

    let mm;
    if ((mm = /^\/clips\/([^/]+)\/(frames\/)?([^/]+)$/.exec(url.pathname))) {
      const dir = clipDir(safeId(mm[1]));
      const file = path.join(dir, mm[2] ? 'frames' : '', path.basename(decodeURIComponent(mm[3])));
      // 畫面格不會變，可以給瀏覽器快取
      return sendFile(res, file, mm[2] ? { 'Cache-Control': 'max-age=86400' } : {});
    }
    if ((mm = /^\/notes\/([^/]+)\/([^/]+)$/.exec(url.pathname))) {
      return sendFile(res, path.join(noteDir(safeId(mm[1])), path.basename(decodeURIComponent(mm[2]))));
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(WEB_DIR, rel));
    if (!file.startsWith(WEB_DIR)) return send(res, 403, { error: 'no' });
    return sendFile(res, file);
  } catch (e) {
    console.error('[錯誤]', e);
    return send(res, 500, { error: e.message || String(e) });
  }
});

// ---------------------------------------------------------------------------
// WebSocket：/ingest（手機）與 /live（瀏覽器）
// ---------------------------------------------------------------------------

const ingestWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
const liveWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ingest') {
    if (url.searchParams.get('t') !== config.token) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    return ingestWss.handleUpgrade(req, socket, head, (ws) => ingestWss.emit('connection', ws, req, url));
  }
  if (url.pathname === '/live' && isLocal(req)) {
    return liveWss.handleUpgrade(req, socket, head, (ws) => liveWss.emit('connection', ws, req));
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

ingestWss.on('connection', (ws, req, url) => {
  // 只接受一支手機；新的連進來就換掉舊的
  if (phone.socket && phone.socket !== ws) {
    try {
      phone.socket.close(4000, 'replaced');
    } catch {}
  }
  phone.socket = ws;
  phone.connected = true;
  phone.connectedAt = Date.now();
  phone.device = url.searchParams.get('d') || 'iPhone';
  phone.model = url.searchParams.get('m') || '';
  console.log(`[手機] 已連上：${phone.device} ${phone.model}（${req.socket.remoteAddress}）`);
  broadcast({ type: 'phone', event: 'connected', phone: phoneStatus() });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return onPhoneFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello') {
        phone.device = msg.device || phone.device;
        phone.model = msg.model || phone.model;
      }
    } catch {}
  });
  const alive = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
  }, 5000);
  ws.on('close', () => {
    clearInterval(alive);
    if (phone.socket === ws) {
      phone.socket = null;
      phone.connected = false;
      console.log('[手機] 已中斷');
      broadcast({ type: 'phone', event: 'disconnected', phone: phoneStatus() });
      const cap = activeSession();
      if (cap) finishCapture(cap.id);
    }
  });
  ws.on('error', () => {});
});

liveWss.on('connection', (ws) => {
  liveClients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', phone: phoneStatus() }));
  if (latest) ws.send(latest.buf, { binary: true });
  ws.on('close', () => liveClients.delete(ws));
  ws.on('error', () => liveClients.delete(ws));
});

// ---------------------------------------------------------------------------

// 上次當掉留下的「錄製中」片段，標成完成
for (const c of listClips()) {
  if (c.status === 'capturing') {
    const frames = readJSON(path.join(clipDir(c.id), 'frames.json'), []);
    writeJSON(path.join(clipDir(c.id), 'meta.json'), { ...c, status: 'ready', frameCount: frames.length });
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n埠號 ${config.port} 已經被占用。芹查可能已經在執行了，直接打開 http://localhost:${config.port} 就好。\n`);
  } else console.error(e);
  process.exit(1);
});

server.listen(config.port, '0.0.0.0', () => {
  const addrs = lanAddresses().filter((a) => !a.virtual);
  console.log('');
  console.log('  芹查已啟動');
  console.log(`  電腦上打開：http://localhost:${config.port}`);
  if (addrs.length) console.log(`  手機連線位址：${addrs.map((a) => a.address).join('、')}`);
  console.log(`  資料存在：${DATA_DIR}`);
  console.log('  關閉這個視窗就會停止芹查。');
  console.log('');
  if (process.argv.includes('--open') && process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', `http://localhost:${config.port}`], { detached: true, stdio: 'ignore' }).unref();
  }
});
