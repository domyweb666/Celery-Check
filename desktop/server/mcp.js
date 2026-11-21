#!/usr/bin/env node
// 芹查 MCP 伺服器：讓 Claude Code 讀取多米在芹查裡框選、寫好的回報，修好後標記。
// 註冊方式（只要做一次）：
//   claude mcp add celery-check --scope user -- node "<這個檔案的完整路徑>"
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, listNotes, getNote, noteDir, noteToText, updateNoteStatus, STATUS_LABEL, localTime } from './store.js';

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
      project: z.string().optional().describe('只列某個專案（例如「茄記」）。不填就列全部專案'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ status = 'todo', project }) => {
    let notes = listNotes();
    if (status === 'todo') notes = notes.filter((n) => TODO.has(n.status));
    else if (status !== 'all') notes = notes.filter((n) => n.status === status);
    if (project) notes = notes.filter((n) => (n.project || '') === project);
    if (!notes.length) return textResult(project ? `專案「${project}」目前沒有符合條件的回報。` : '目前沒有符合條件的回報。');
    const lines = notes.map(
      (n) =>
        `- #${n.number}（id: ${n.id}）[${STATUS_LABEL[n.status]}] [${n.project || '未分類'}] [嚴重度 ${n.severity}] ${n.title}　${localTime(n.createdAt)}`,
    );
    return textResult(`共 ${notes.length} 筆：\n${lines.join('\n')}\n\n用 celery_get_note 讀取每一筆的圖片和完整說明。`);
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
