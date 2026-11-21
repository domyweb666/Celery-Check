// 芹查：資料存放（伺服器和 MCP 共用）
// 所有東西都存在 desktop/data 底下，純檔案，沒有資料庫。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const DATA_DIR = process.env.CELERY_DATA_DIR
  ? path.resolve(process.env.CELERY_DATA_DIR)
  : path.join(ROOT, 'data');
export const CLIPS_DIR = path.join(DATA_DIR, 'clips');
export const NOTES_DIR = path.join(DATA_DIR, 'notes');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

for (const d of [DATA_DIR, CLIPS_DIR, NOTES_DIR]) fs.mkdirSync(d, { recursive: true });

export const STATUS_LABEL = {
  open: '待修',
  reopened: '退回重修',
  fixed: '已修好，待驗收',
  closed: '已結案',
};

const DEFAULT_CONFIG = {
  port: 7790,
  token: '',
  pcName: '',
  preSeconds: 20,
  bufferSeconds: 40,
  markKeys: ['F8', 'PageDown', 'PageUp'],
  recordKeys: ['F9'],
  openReviewAfterMark: false,
  // 先放好多米現有的 app，「電腦上的資料夾」到設定頁補
  projects: [
    { name: '茄記', repo: 'domyweb666/qieji-app', localPath: '' },
    { name: '白菜記帳', repo: 'domyweb666/Cabbage-Bookkeeping', localPath: '' },
    { name: '花椰菜相機', repo: 'domyweb666/Broccoli-Cam', localPath: '' },
    { name: '人蔘修煉', repo: 'domyweb666/Ginseng-Cultivation', localPath: '' },
    { name: '洋蔥', repo: 'domyweb666/Onion-Map', localPath: '' },
    { name: '捏捏史萊姆', repo: 'domyweb666/nienie-slime', localPath: '' },
    { name: '月曆', repo: 'domyweb666/Counting-days', localPath: '' },
    { name: '豆鍵', repo: 'domyweb666/bigkeyboard', localPath: '' },
    { name: '芹查', repo: 'domyweb666/Celery-Check', localPath: '' },
  ],
  nextNoteNumber: 1,
  nextSessionNumber: 1,
  lastProject: '',
};

// ---------- 小工具 ----------

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 先寫暫存檔再改名，避免伺服器和 MCP 同時寫時讀到半個檔案
export function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function localTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 只允許安全的 id，避免路徑穿越
export function safeId(id) {
  const s = String(id ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error(`不合法的編號：${s}`);
  return s;
}

// ---------- 設定 ----------

export function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG, ...readJSON(CONFIG_PATH, {}) };
  let dirty = false;
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(12).toString('hex');
    dirty = true;
  }
  if (process.env.CELERY_PORT) cfg.port = Number(process.env.CELERY_PORT);
  if (dirty) writeJSON(CONFIG_PATH, cfg);
  return cfg;
}

export function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  writeJSON(CONFIG_PATH, cfg);
  return cfg;
}

function takeNoteNumber() {
  const raw = { ...DEFAULT_CONFIG, ...readJSON(CONFIG_PATH, {}) };
  // 以實際存在的最大號碼為準，避免設定檔被還原時撞號
  let max = 0;
  for (const name of fs.readdirSync(NOTES_DIR)) {
    const n = Number(name);
    if (Number.isInteger(n) && n > max) max = n;
  }
  const n = Math.max(raw.nextNoteNumber || 1, max + 1);
  raw.nextNoteNumber = n + 1;
  writeJSON(CONFIG_PATH, raw);
  return n;
}

export function takeSessionNumber() {
  const raw = { ...DEFAULT_CONFIG, ...readJSON(CONFIG_PATH, {}) };
  let max = 0;
  for (const c of listClips()) if (Number.isInteger(c.number) && c.number > max) max = c.number;
  const n = Math.max(raw.nextSessionNumber || 1, max + 1);
  raw.nextSessionNumber = n + 1;
  writeJSON(CONFIG_PATH, raw);
  return n;
}

// ---------- 測試場次（clip） ----------
// data/clips/<id>/meta.json   { id, createdAt, kind: 'mark'|'record', status: 'capturing'|'ready', markTime, frameCount }
// data/clips/<id>/frames.json [{ f: '000001.jpg', t: 毫秒時間戳 }]
// data/clips/<id>/frames/*.jpg

export function clipDir(id) {
  return path.join(CLIPS_DIR, safeId(id));
}

export function listClips() {
  const out = [];
  for (const name of fs.readdirSync(CLIPS_DIR)) {
    const meta = readJSON(path.join(CLIPS_DIR, name, 'meta.json'), null);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export function getClip(id) {
  const dir = clipDir(id);
  const meta = readJSON(path.join(dir, 'meta.json'), null);
  if (!meta) return null;
  const frames = readJSON(path.join(dir, 'frames.json'), []);
  return { ...meta, frames };
}

export function deleteClip(id) {
  fs.rmSync(clipDir(id), { recursive: true, force: true });
}

// ---------- 回報（note） ----------
// data/notes/<編號>/note.json
// data/notes/<編號>/full.png      整張畫面＋標註
// data/notes/<編號>/crop.png      框選處放大
// data/notes/<編號>/raw.jpg       沒有標註的原始畫面
// data/notes/<編號>/sequence.jpg  前後連續畫面拼圖
// data/notes/<編號>/after-*.jpg   驗收時拍的修改後畫面

export function noteDir(id) {
  return path.join(NOTES_DIR, safeId(id));
}

export function listNotes() {
  const out = [];
  for (const name of fs.readdirSync(NOTES_DIR)) {
    const note = readJSON(path.join(NOTES_DIR, name, 'note.json'), null);
    if (note) out.push(note);
  }
  out.sort((a, b) => b.number - a.number);
  return out;
}

export function getNote(id) {
  return readJSON(path.join(noteDir(id), 'note.json'), null);
}

export function saveNote(note) {
  const dir = noteDir(note.id);
  fs.mkdirSync(dir, { recursive: true });
  note.updatedAt = Date.now();
  writeJSON(path.join(dir, 'note.json'), note);
  return note;
}

function writeDataUrl(file, dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return false;
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return true;
}

export function createNote(input) {
  const number = takeNoteNumber();
  const id = String(number);
  const dir = noteDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const files = {};
  if (writeDataUrl(path.join(dir, 'full.png'), input.images?.full)) files.full = 'full.png';
  if (writeDataUrl(path.join(dir, 'crop.png'), input.images?.crop)) files.crop = 'crop.png';
  if (writeDataUrl(path.join(dir, 'sequence.jpg'), input.images?.sequence)) files.sequence = 'sequence.jpg';

  // 原始畫面直接從片段複製，不經過瀏覽器重新壓縮
  if (input.clipId && input.frameFile) {
    try {
      const src = path.join(clipDir(input.clipId), 'frames', path.basename(input.frameFile));
      fs.copyFileSync(src, path.join(dir, 'raw.jpg'));
      files.raw = 'raw.jpg';
    } catch {
      /* 片段已被刪除就算了 */
    }
  }

  const now = Date.now();
  const description = String(input.description || '').trim();
  const note = {
    id,
    number,
    title: description.split(/\r?\n/)[0].slice(0, 40) || `回報 #${number}`,
    description,
    project: String(input.project || '').trim(),
    status: 'open',
    createdAt: now,
    clipId: input.clipId || null,
    sessionNumber: input.sessionNumber ?? null,
    frameFile: input.frameFile || null,
    frameTime: input.frameTime ?? null, // 這一格在片段裡的秒數
    range: input.range || null, // { start, end } 秒
    frameSize: input.frameSize || null, // { w, h }
    annotations: Array.isArray(input.annotations) ? input.annotations : [],
    files,
    fixSummary: '',
    fixedAt: null,
    history: [{ at: now, by: '多米', action: 'created', text: '建立回報' }],
  };
  return saveNote(note);
}

export function updateNoteStatus(id, { status, text = '', by = '多米', afterImage } = {}) {
  const note = getNote(id);
  if (!note) throw new Error(`找不到回報 #${id}`);
  if (status && !STATUS_LABEL[status]) throw new Error(`不認得的狀態：${status}`);
  const now = Date.now();
  const entry = { at: now, by, action: status || 'comment', text };
  if (afterImage) {
    const name = `after-${now}.jpg`;
    if (writeDataUrl(path.join(noteDir(id), name), afterImage)) {
      entry.image = name;
      note.files.after = name;
    }
  }
  if (status) note.status = status;
  if (status === 'fixed') {
    note.fixSummary = text;
    note.fixedAt = now;
  }
  note.history = [...(note.history || []), entry];
  return saveNote(note);
}

export function deleteNote(id) {
  fs.rmSync(noteDir(id), { recursive: true, force: true });
}

// 給人和 Claude 看的純文字版回報
export function describeAnnotations(note) {
  const size = note.frameSize;
  const pct = (v) => `${Math.round(v * 100)}%`;
  return (note.annotations || [])
    .map((a, i) => {
      const n = i + 1;
      const label = a.text ? `，旁邊寫著「${a.text}」` : '';
      switch (a.type) {
        case 'rect':
          return `${n}. 紅框：左上 (${pct(a.x)}, ${pct(a.y)})，寬 ${pct(a.w)}、高 ${pct(a.h)}${label}`;
        case 'ellipse':
          return `${n}. 圓圈：中心 (${pct(a.x + a.w / 2)}, ${pct(a.y + a.h / 2)})，寬 ${pct(a.w)}、高 ${pct(a.h)}${label}`;
        case 'arrow':
          return `${n}. 箭頭：從 (${pct(a.x1)}, ${pct(a.y1)}) 指向 (${pct(a.x2)}, ${pct(a.y2)})${label}`;
        case 'pen':
          return `${n}. 手繪線條（約在 ${pct(a.bx ?? 0)}, ${pct(a.by ?? 0)} 附近）${label}`;
        case 'text':
          return `${n}. 文字標籤「${a.text}」位於 (${pct(a.x)}, ${pct(a.y)})`;
        default:
          return `${n}. ${a.type}`;
      }
    })
    .join('\n')
    .concat(size ? `\n（座標是相對畫面的百分比，畫面原始大小 ${size.w}×${size.h}）` : '');
}

function fmtSec(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  return `${Math.floor(s / 60)} 分 ${(s % 60).toFixed(1)} 秒`;
}

export function noteToText(note) {
  const lines = [];
  lines.push(`# 芹查回報 #${note.number}：${note.title}`);
  lines.push(`狀態：${STATUS_LABEL[note.status] || note.status}　專案：${note.project || '未分類'}`);
  lines.push(`建立時間：${localTime(note.createdAt)}${note.sessionNumber ? `（第 ${note.sessionNumber} 場測試）` : ''}`);
  if (note.frameTime != null) {
    let t = `問題畫面在這場測試錄影的第 ${fmtSec(note.frameTime)}`;
    if (note.range) t += `；多米選的區間是 ${fmtSec(note.range.start)} 到 ${fmtSec(note.range.end)}`;
    lines.push(t);
  }
  lines.push('');
  lines.push('## 多米的說明');
  lines.push(note.description || '（沒有寫說明，請看圖上的標註）');
  if (note.annotations?.length) {
    lines.push('');
    lines.push('## 圖上的標註');
    lines.push(describeAnnotations(note));
  }
  const extra = (note.history || []).filter((h) => h.action !== 'created');
  if (extra.length) {
    lines.push('');
    lines.push('## 處理紀錄');
    for (const h of extra) {
      const what = STATUS_LABEL[h.action] || h.action;
      lines.push(`- ${localTime(h.at)} ${h.by}：${what}${h.text ? `——${h.text}` : ''}`);
    }
  }
  return lines.join('\n');
}
