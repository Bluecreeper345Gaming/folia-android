const r = await fetch('http://127.0.0.1:9222/json');
const j = await r.json();
for (const t of j) console.log(t.type, t.id, (t.url||'').slice(0,70));
process.exit(0);
