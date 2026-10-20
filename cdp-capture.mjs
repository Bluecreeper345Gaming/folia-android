import WebSocket from 'ws';
import fs from 'fs';

const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/0B68970E03649B84292233F68E8D374F', { perMessageDeflate: false, maxPayload: 512*1024*1024 });
let id = 0; const pending = new Map();
const send = (method, params={}) => new Promise((res) => { const i=++id; pending.set(i,res); ws.send(JSON.stringify({id:i,method,params})); });
const dump = [];

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (u.includes('musicu.fcg') || u.includes('getMusicPlay') || u.includes('vkey')) {
      dump.push({ type:'req', url: u.slice(0,300), body: m.params.request.postData ?? '' });
    }
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (u.includes('musicu.fcg') || u.includes('getMusicPlay')) {
      const rid = m.params.requestId;
      send('Network.getResponseBody', { requestId: rid }).then(r => {
        if (r?.body) dump.push({ type:'res', url: u.slice(0,120), body: (r.base64Encoded ? Buffer.from(r.body,'base64').toString('utf8') : r.body).slice(0, 200000) });
      }).catch(()=>{});
    }
  }
});

ws.on('open', async () => {
  await send('Network.enable', { maxPostDataSize: 1000000, maxResourceBufferSize: 100000000, maxTotalBufferSize: 200000000 });
  console.log('capturing...');
});

setInterval(() => {
  if (dump.length) { fs.appendFileSync('desktop-net.json', JSON.stringify(dump.splice(0), null, 1)); }
}, 3000);
setTimeout(() => { if (dump.length) fs.appendFileSync('desktop-net.json', JSON.stringify(dump.splice(0))); console.log('DONE', fs.statSync('desktop-net.json').size); process.exit(0); }, 120000);
