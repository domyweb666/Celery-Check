// 模擬手機：不用真的 iPhone，也能測試芹查的介面。
// 需要 ffmpeg。用法：npm run fake-phone   （可加 -- --fps 15 --seconds 60）
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { loadConfig } from '../server/store.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const fps = Number(opt('fps', 15));
const seconds = Number(opt('seconds', 0)); // 0 = 一直跑
const host = opt('host', '127.0.0.1');
const { port, token } = loadConfig();

const ws = new WebSocket(`ws://${host}:${port}/ingest?t=${token}&d=${encodeURIComponent('模擬 iPhone')}&m=fake`);
ws.on('open', () => {
  console.log(`已連上芹查（${host}:${port}），每秒 ${fps} 格`);
  ws.send(JSON.stringify({ type: 'hello', device: '模擬 iPhone', model: 'fake' }));
  const ff = spawn(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-re',
      '-f', 'lavfi',
      '-i', `testsrc2=size=590x1278:rate=${fps}`,
      ...(seconds ? ['-t', String(seconds)] : []),
      '-f', 'image2pipe',
      '-q:v', '6',
      '-vcodec', 'mjpeg',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  );
  let pending = Buffer.alloc(0);
  ff.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) break;
      const end = pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) break;
      const jpeg = pending.subarray(start, end + 2);
      pending = pending.subarray(end + 2);
      const head = Buffer.alloc(8);
      head.writeBigUInt64BE(BigInt(Date.now()));
      if (ws.readyState === 1) ws.send(Buffer.concat([head, jpeg]));
    }
  });
  ff.on('error', () => {
    console.error('找不到 ffmpeg。模擬手機需要 ffmpeg。');
    process.exit(1);
  });
  ff.on('close', () => {
    console.log('模擬結束');
    ws.close();
  });
});
ws.on('close', (code) => {
  console.log(`連線關閉（${code}）`);
  process.exit(0);
});
ws.on('error', (e) => {
  console.error('連不上芹查：', e.message);
  process.exit(1);
});
