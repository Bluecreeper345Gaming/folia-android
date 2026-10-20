import WebSocket from 'ws'; import fs from 'fs';
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/0B68970E03649B84292233F68E8D374F', { maxPayload: 512*1024*1024 });
let id=0; const pend=new Map(); const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.on('message',(raw)=>{const m=JSON.parse(raw.toString()); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}});
ws.on('open', async ()=>{
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd==='shot') { const s=await send('Page.captureScreenshot',{format:'jpeg',quality:60}); fs.writeFileSync(args[0]||'desk.jpg', Buffer.from(s.data,'base64')); console.log('shot ok'); }
  if (cmd==='tap') { const [x,y]=args.map(Number); await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1}); await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1}); console.log('tap ok', x, y); }
  process.exit(0);
});
