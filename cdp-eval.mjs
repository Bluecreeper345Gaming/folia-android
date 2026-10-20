// cdp-eval.mjs — 通过 CDP 在 WebView 里执行表达式，打印结果
// 用法: node cdp-eval.mjs "<expression>"
import { execSync } from 'child_process';
import WebSocket from 'ws';

const adb = process.env.ADB || 'adb';
const pkg = process.env.PKG || 'ti.folia.ming';
const pid = execSync(`${adb} shell pidof ${pkg}`).toString().trim().split(/\s+/)[0];
execSync(`${adb} forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);

const res = await fetch('http://127.0.0.1:9222/json');
const targets = await res.json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
const expr = process.argv[2];

ws.on('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }));
  ws.send(JSON.stringify({
    id: 2,
    method: 'Runtime.evaluate',
    params: { expression: expr, awaitPromise: true, returnByValue: true, timeout: 30000 },
  }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id === 2) {
    const r = msg.result?.result;
    if (msg.result?.exceptionDetails) {
      console.log('EXCEPTION:', JSON.stringify(msg.result.exceptionDetails, null, 2).slice(0, 3000));
    } else {
      console.log(typeof r?.value === 'string' ? r.value : JSON.stringify(r?.value, null, 2)?.slice(0, 3000));
    }
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 35000);
