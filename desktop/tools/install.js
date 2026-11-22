// 芹查安裝程式（Windows）：安裝套件、加到 Claude Code、在桌面建捷徑。
// 由「安裝芹查.cmd」呼叫。邏輯放在這裡而不是 .cmd，因為 Windows 命令列讀含中文的 .cmd 會把行切壞。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP, '..');
const isWin = process.platform === 'win32';
const say = (s = '') => console.log(s ? `  ${s}` : '');

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, windowsHide: true, ...opts });
}

function quiet(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'ignore', shell: isWin, windowsHide: true });
}

say();
say('==== 安裝芹查（電腦端）====');
say();

// 1. 套件
say('[1/3] 安裝需要的套件…');
const npm = run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: DESKTOP });
if (npm.status !== 0) {
  say();
  say('套件安裝失敗。請確認網路正常後，再雙擊一次「安裝芹查.cmd」。');
  process.exit(1);
}

// 2. Claude Code
say();
say('[2/3] 把芹查加到 Claude Code…');
const mcpPath = path.join(DESKTOP, 'server', 'mcp.js');
if (quiet('claude', ['--version']).status !== 0) {
  say('沒找到 claude 指令，先跳過。之後到芹查的「設定」頁複製指令，貼到命令提示字元執行即可。');
} else {
  quiet('claude', ['mcp', 'remove', 'celery-check', '--scope', 'user']);
  const add = run('claude', ['mcp', 'add', 'celery-check', '--scope', 'user', '--', 'node', `"${mcpPath}"`]);
  if (add.status === 0) say('完成。之後在任何專案打開 Claude Code，都能用芹查的工具。');
  else say('加入失敗。之後到芹查的「設定」頁複製指令手動執行。');
}

// 3. 桌面捷徑：用 PowerShell 的 -EncodedCommand（UTF-16），中文路徑才不會壞掉
say();
say('[3/3] 在桌面建立「芹查」捷徑…');
if (!isWin) {
  say('不是 Windows，跳過。');
} else {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const target = path.join(ROOT, '啟動芹查.cmd');
  const icon = path.join(DESKTOP, 'web', 'icon.ico');
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "$desk = [Environment]::GetFolderPath('Desktop')",
    "$lnk = Join-Path $desk '芹查.lnk'",
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)',
    `$s.TargetPath = ${q(target)}`,
    `$s.WorkingDirectory = ${q(ROOT)}`,
    fs.existsSync(icon) ? `$s.IconLocation = ${q(icon)}` : '',
    "$s.Description = '芹查：iPhone 真機測試回報工具'",
    '$s.Save()',
    'Write-Output $lnk',
  ]
    .filter(Boolean)
    .join('; ');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status === 0) {
    say(`完成：${(r.stdout || '').trim()}`);
  } else {
    say('建立捷徑失敗，直接雙擊資料夾裡的「啟動芹查.cmd」也一樣。');
    const err = (r.stderr || '').trim().split(/\r?\n/).slice(0, 3).join(' ');
    if (err) say(`（原因：${err}）`);
  }
}

say();
say('全部裝好了。雙擊桌面的「芹查」就能開始用。');
say('第一次啟動時 Windows 會問要不要讓 Node.js 通過防火牆，請勾「私人網路」並按允許，手機才連得到。');
say();
