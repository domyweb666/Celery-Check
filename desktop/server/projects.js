// 芹查：找出電腦上的 iOS app 專案
// 判斷「這個資料夾是哪個 app」：讀資料夾的 .git 設定拿 GitHub repo 名稱（例如 domyweb666/qieji-app），
// 跟設定裡的專案清單逐字比對。新專案：掃描電腦上的資料夾，只挑 iOS app（Xcode、XcodeGen、Expo、Flutter），
// 網站、腳本之類的專案不會加進來。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from './store.js';

// ---------- git ----------

export function findGitRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

export function readGitRepo(root) {
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

export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (x) => path.resolve(x).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

// ---------- 是不是 iOS app ----------

function readSmall(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 400 * 1024) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function hasXcodeProject(dir) {
  try {
    return fs.readdirSync(dir).some((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'));
  } catch {
    return false;
  }
}

/** 回傳這個資料夾是哪一種 iOS app（XcodeGen、Xcode、Expo…），不是就回 null */
export function iosAppKind(dir) {
  const yml = readSmall(path.join(dir, 'project.yml'));
  if (yml && /\biOS\b/.test(yml)) return 'XcodeGen';
  const iosDir = path.join(dir, 'ios');
  const iosYml = readSmall(path.join(iosDir, 'project.yml'));
  if (iosYml && /\biOS\b/.test(iosYml)) return 'XcodeGen';
  if (hasXcodeProject(dir) || hasXcodeProject(iosDir)) return 'Xcode';
  const pkg = readSmall(path.join(dir, 'package.json'));
  if (pkg && /"(expo|react-native)"\s*:/.test(pkg)) return 'Expo / React Native';
  const appJson = readSmall(path.join(dir, 'app.json'));
  if (appJson && /"expo"\s*:/.test(appJson)) return 'Expo';
  if (fs.existsSync(path.join(dir, 'pubspec.yaml')) && fs.existsSync(iosDir)) return 'Flutter';
  const spm = readSmall(path.join(dir, 'Package.swift'));
  if (spm && /\.iOS\s*\(/.test(spm)) return 'Swift Package';
  return null;
}

// ---------- 掃描 ----------

const SKIP = new Set(
  [
    'node_modules', 'AppData', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin',
    'System Volume Information', 'Recovery', 'PerfLogs', 'Library', 'Applications', 'build', 'dist', 'DerivedData',
    'Pods', 'venv', '.venv', '__pycache__', 'vendor', 'target', 'out', 'Music', 'Videos', 'Pictures', 'Saved Games',
    'Contacts', 'Favorites', 'Links', 'Searches', 'WPS Cloud Files', 'OneDriveTemp',
  ].map((x) => x.toLowerCase()),
);

/** 預設掃描的地方：使用者資料夾（往下 4 層），以及 D: 之後各個磁碟（往下 3 層） */
export function defaultScanRoots() {
  const roots = [{ dir: os.homedir(), depth: 4 }];
  if (process.platform === 'win32') {
    for (const L of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const d = `${L}:\\`;
      try {
        if (fs.existsSync(d)) roots.push({ dir: d, depth: 3 });
      } catch {}
    }
  }
  return roots;
}

async function walk(root, depth, found, budget) {
  const queue = [{ dir: root, d: 0 }];
  while (queue.length && budget.left > 0) {
    const { dir, d } = queue.shift();
    budget.left--;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.name === '.git')) {
      found.push(dir);
      continue; // repo 裡面不用再往下找
    }
    if (d >= depth) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name.startsWith('$') || SKIP.has(e.name.toLowerCase())) continue;
      queue.push({ dir: path.join(dir, e.name), d: d + 1 });
    }
  }
}

let scanning = null;

/** 掃描電腦上的 iOS app，加進專案清單。回傳新加入的專案。 */
export function scanProjects() {
  if (scanning) return scanning;
  scanning = (async () => {
    const cfg = loadConfig();
    const roots = [
      ...defaultScanRoots(),
      ...(cfg.scanRoots || []).filter(Boolean).map((dir) => ({ dir, depth: 4 })),
    ];
    const repos = [];
    const budget = { left: 40000 };
    for (const r of roots) await walk(r.dir, r.depth, repos, budget);

    const projects = [...(loadConfig().projects || [])];
    const added = [];
    const filled = [];
    for (const dir of [...new Set(repos)]) {
      const kind = iosAppKind(dir);
      if (!kind) continue;
      const repo = readGitRepo(dir);
      let p = projects.find((x) => samePath(x.localPath, dir)) || (repo && projects.find((x) => x.repo && x.repo.toLowerCase() === repo.toLowerCase()));
      if (p) {
        if (!p.localPath) {
          p.localPath = dir;
          filled.push(p.name);
        }
        continue;
      }
      const name = repo ? repo.split('/')[1] : path.basename(dir);
      p = { name, repo: repo || '', localPath: dir, found: kind };
      projects.push(p);
      added.push(p);
    }
    if (added.length || filled.length) saveConfig({ projects });
    return { added, filled, scannedRepos: repos.length, at: Date.now() };
  })().finally(() => {
    setTimeout(() => (scanning = null), 0);
  });
  return scanning;
}

/** Claude Code 所在的資料夾對應哪個專案（MCP 用） */
export function detectProject(cwd) {
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
  if (repo && iosAppKind(root)) {
    const name = repo.split('/')[1];
    projects.push({ name, repo, localPath: root });
    saveConfig({ projects });
    return { name, root, repo, learned: true };
  }
  return { name: null, root, repo, learned: false };
}
