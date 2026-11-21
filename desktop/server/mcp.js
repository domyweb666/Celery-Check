#!/usr/bin/env node
// 芹查 MCP 伺服器：讓 Claude Code 讀取多米在芹查裡框選、寫好的回報，修好後標記。
// 註冊方式（只要做一次）：
//   claude mcp add celery-check --scope user -- node "<這個檔案的完整路徑>"
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, saveConfig, listNotes, listClips, getNote, noteDir, noteToText, updateNoteStatus, STATUS_LABEL, localTime } from './store.js';

// ---------------------------------------------------------------------------
// Claude Code 是在哪個專案資料夾打開的？
// 找資料夾裡的 .git，讀 GitHub repo 名稱，對到芹查設定裡的專案。
// 對到了而芹查還不知道這個專案在電腦上的哪裡，就順便記下來（「用 Claude Code 開啟」會用到）。
// ---------------------------------------------------------------------------

function findGitRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function readGitRepo(root) {
  try {
    let gitDir = path.join(root, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(gitDir, 'utf8'));
      if (m) gitDir = path.resolve(root, m[1].trim());
    }
    const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const urls = [...cfg.matchAll(/url\s*=\s*(.+)/g)].map((x) => x[1].trim());
    for (const u of urls) {
      const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u);
      if (m) return `${m[1]}/${m[2]}`;
    }
  } catch {}
  return null;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (x) => path.resolve(x).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function detectProject() {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findGitRoot(cwd) || cwd;
  const repo = readGitRepo(root);
  const cfg = loadConfig();
  const projects = [...(cfg.projects || [])];
  let p = projects.find((x) => samePath(x.localPath, root));
  if (!p && repo) p = projects.find((x) => x.repo && x.repo.toLowerCase() === repo.toLowerCase());
  if (p) {
    if (!p.localPath) {
      p.localPath = root;
      saveConfig({ projects });
    }
    return { name: p.name, root, repo, learned: false };
  }
  if (repo) {
    // 芹查還不認識這個 repo：用 repo 名稱新增一個專案
    const name = repo.split('/')[1];
    projects.push({ name, repo, localPath: root });
    saveConfig({ projects });
    return { name, root, repo, learned: true };
  }
  return { name: null, root, repo: null, learned: false };
}

let here = null;
function currentProject() {
  if (!here) here = detectProject();
  return here;
}


const server = new McpServer({ name: 'celery-check', version: '0.1.0' });

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function imageContent(file) {
  try {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    return { type: 'image', data: buf.toString('base64'), mimeType: ext === '.png' ? 'image/png' : 'image/jpeg' };
  } catch {
    return null;
  }
}

async function notifyUi() {
  try {
    const { port } = loadConfig();
    await fetch(`http://127.0.0.1:${port}/api/notify`, { method: 'POST', signal: AbortSignal.timeout(1500) });
  } catch {
    /* 芹查介面沒開也沒關係 */
  }
}

const TODO = new Set(['open', 'reopened']);

server.registerTool(
  'celery_list_notes',
  {
    title: '列出芹查回報',
    description:
      '列出多米在「芹查」裡對 iPhone 真機畫面框選、標記後送出的問題回報。預設只列待修（含被退回重修的）。拿到清單後，用 celery_get_note 逐筆讀取圖片和說明。',
    inputSchema: {
      status: z
        .enum(['todo', 'open', 'reopened', 'fixed', 'closed', 'all'])
        .optional()
        .describe('todo＝待修＋退回重修（預設）；fixed＝已修好待驗收；closed＝已結案；all＝全部'),
      project: z
        .string()
        .optional()
        .describe('專案名稱（例如「茄記」）。不填就自動用目前資料夾對應的專案；填 "all" 列全部專案'),
      session: z.string().optional().describe('只列某一場測試的回報（芹查給的 session id，例如 20261122-051200）'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ status = 'todo', project, session }) => {
    let notes = listNotes();
    if (status === 'todo') notes = notes.filter((n) => TODO.has(n.status));
    else if (status !== 'all') notes = notes.filter((n) => n.status === status);
    let scope = '';
    const cur = currentProject();
    if (session) {
      notes = notes.filter((n) => n.clipId === session);
      scope = `這場測試（${session}）`;
    } else if (project && project !== 'all') {
      notes = notes.filter((n) => (n.project || '') === project);
      scope = `「${project}」`;
    } else if (!project && cur.name) {
      notes = notes.filter((n) => (n.project || '') === cur.name);
      scope = `「${cur.name}」`;
    }
    const head = cur.name
      ? `目前資料夾 ${cur.root} 對應芹查的專案「${cur.name}」${cur.learned ? '（芹查第一次看到這個 repo，已自動新增）' : ''}。`
      : `目前資料夾 ${cur.root} 不是芹查認得的專案，所以列出全部專案的回報。`;
    if (!notes.length) {
      const other = listNotes().filter((n) => TODO.has(n.status) && (n.project || '') !== cur.name).length;
      return textResult(`${head}\n${scope || ''}目前沒有符合條件的回報。${other && !project ? `（其他專案還有 ${other} 筆待修，要看的話 project 填 "all"）` : ''}`);
    }
    // 同一場測試的放在一起，依時間排
    notes.sort((a, b) => (a.clipId || '').localeCompare(b.clipId || '') || (a.frameTime ?? 0) - (b.frameTime ?? 0));
    const lines = notes.map(
      (n) =>
        `- #${n.number}（id: ${n.id}）[${STATUS_LABEL[n.status]}] [${n.project || '未分類'}]${n.sessionNumber ? ` [第 ${n.sessionNumber} 場]` : ''} ${n.title}`,
    );
    return textResult(`${head}\n${scope}共 ${notes.length} 筆：\n${lines.join('\n')}\n\n用 celery_get_note 逐筆讀取圖片和完整說明。同一場測試的回報常常互相有關，建議全部讀完再動手改。`);
  },
);

server.registerTool(
  'celery_get_note',
  {
    title: '讀取一筆芹查回報',
    description:
      '讀取一筆回報的完整內容：多米的文字說明、標註座標、處理紀錄，以及圖片——(1) 框選處放大圖 (2) 整張畫面加標註 (3) 問題發生前後的連續畫面拼圖（看動畫、轉場、手勢問題用）(4) 若曾被退回，附驗收時拍的修改後畫面。紅色標註是多米畫的，不是 app 本身的畫面。',
    inputSchema: {
      id: z.string().describe('回報編號，例如 "12"（celery_list_notes 會列出）'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => {
    const clean = String(id).replace(/^#/, '');
    let note;
    try {
      note = getNote(clean);
    } catch (e) {
      return textResult(e.message, true);
    }
    if (!note) return textResult(`找不到回報 #${clean}`, true);
    const dir = noteDir(note.id);
    const content = [{ type: 'text', text: noteToText(note) }];
    const cur = currentProject();
    if (cur.name && note.project && note.project !== cur.name) {
      content.unshift({ type: 'text', text: `⚠ 注意：這筆回報屬於「${note.project}」，但目前資料夾是「${cur.name}」。請確認是不是開錯專案，不要在這裡改。` });
    }
    const add = (file, caption) => {
      if (!file) return;
      const img = imageContent(path.join(dir, file));
      if (img) {
        content.push({ type: 'text', text: caption });
        content.push(img);
      }
    };
    add(note.files?.crop, '【圖一】多米框選的地方（放大）：');
    add(note.files?.full, '【圖二】整張手機畫面＋多米的標註：');
    add(note.files?.sequence, '【圖三】問題發生前後的連續畫面（由左到右、由上到下，紅框那格是多米停下來標註的畫面）：');
    if (note.status === 'reopened' && note.files?.after) add(note.files.after, '【圖四】多米驗收時拍的「修改後」畫面，問題還在：');
    content.push({
      type: 'text',
      text: '\n修好後請呼叫 celery_mark_fixed，用一兩句中文寫你改了什麼、多米驗收時要看哪裡。看不懂多米的意思時，用 celery_comment 留言問他，不要猜。',
    });
    return { content };
  },
);

server.registerTool(
  'celery_mark_fixed',
  {
    title: '把回報標成已修好',
    description: '修完一筆回報後呼叫。狀態會變成「已修好，待驗收」，多米裝上新版後會在芹查裡逐筆驗收。summary 用繁體中文寫改了什麼、要看哪裡。',
    inputSchema: {
      id: z.string().describe('回報編號'),
      summary: z.string().min(2).describe('改了什麼、多米驗收時要看哪裡（繁體中文，一兩句）'),
    },
  },
  async ({ id, summary }) => {
    try {
      const note = updateNoteStatus(String(id).replace(/^#/, ''), { status: 'fixed', text: summary, by: 'Claude' });
      await notifyUi();
      return textResult(`已把 #${note.number} 標成「已修好，待驗收」。`);
    } catch (e) {
      return textResult(e.message, true);
    }
  },
);

server.registerTool(
  'celery_comment',
  {
    title: '在回報上留言',
    description: '對一筆回報留言但不改狀態，例如看不懂多米的意思要問他、或說明為什麼這筆不用改。多米會在芹查介面看到。',
    inputSchema: {
      id: z.string().describe('回報編號'),
      text: z.string().min(1).describe('留言內容（繁體中文）'),
    },
  },
  async ({ id, text }) => {
    try {
      const note = updateNoteStatus(String(id).replace(/^#/, ''), { text, by: 'Claude' });
      await notifyUi();
      return textResult(`已在 #${note.number} 留言。`);
    } catch (e) {
      return textResult(e.message, true);
    }
  },
);

server.registerTool(
  'celery_screenshot',
  {
    title: '截取手機現在的畫面',
    description:
      '截取多米 iPhone 現在的畫面（手機要正在用芹查投影到電腦）。用來確認目前畫面長怎樣，或請多米把手機切到某個畫面後再截一次。',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const { port } = loadConfig();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/screenshot`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        return textResult(j.error || '拿不到畫面。請確認手機正在用芹查投影。', true);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const age = Number(r.headers.get('x-frame-age') || 0);
      const connected = r.headers.get('x-phone-connected') === '1';
      const note = connected
        ? `手機投影中。這張畫面是 ${(age / 1000).toFixed(1)} 秒前的（畫面沒變動時手機不會送新格，所以秒數大不代表斷線）。`
        : '注意：手機目前沒有在投影，這是最後收到的畫面。';
      return { content: [{ type: 'text', text: note }, { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }] };
    } catch {
      return textResult(`連不到芹查（http://127.0.0.1:${port}）。請多米先開啟芹查。`, true);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
