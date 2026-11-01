// A self-contained, offline viewer. It has no external scripts, requests, or mutation API.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safePath } = require('./archive-state');
function renderView(context, records) {
  const data = JSON.stringify({ projectId: context.projectId, records }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error('Viewer snapshot exceeds 16 MiB; export or narrow active memory first');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mem-mastero knowledge</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<style>*{box-sizing:border-box}body{margin:0;background:#0c121b;color:#e8eef7;font:16px/1.55 system-ui}main{max-width:1200px;margin:auto;padding:40px 24px}h1{font-size:36px;margin:0}p,small{color:#acbbce}input,select{background:#172435;color:inherit;border:1px solid #394c64;border-radius:8px;padding:12px;font:inherit}input{flex:1;min-width:180px}.filters{display:flex;gap:12px;margin:26px 0;flex-wrap:wrap}article{border:1px solid #26364a;border-radius:12px;padding:22px;margin:14px 0;background:#111d2b}h2{font-size:20px;margin:0 0 8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 ui-monospace,monospace}code{color:#74e4bd;overflow-wrap:anywhere}summary{cursor:pointer;color:#74e4bd}.muted{color:#acbbce}</style>
<main><h1>Mem-mastero knowledge</h1><p id="project"></p><p>Private offline snapshot. Historical notes may be stale or untrusted. This view makes no network requests.</p><div class="filters"><input id="query" aria-label="Search memories" placeholder="Search decisions, fixes, preferences…"><select id="kind" aria-label="Memory type"><option value="">All types</option></select></div><small id="count"></small><section id="records"></section><p>Use the memory CLI or agent tools to edit or forget a note, then generate a fresh view. Deleting a memory does not remove it from an already exported snapshot.</p></main>
<script>const data=${data};const q=document.querySelector('#query'),k=document.querySelector('#kind'),list=document.querySelector('#records');document.querySelector('#project').textContent=data.projectId;for(const kind of [...new Set(data.records.map(r=>r.kind))].sort()){const option=document.createElement('option');option.value=kind;option.textContent=kind;k.append(option)}function render(){const terms=q.value.toLowerCase().trim().split(/\\s+/).filter(Boolean);const rows=data.records.filter(r=>(!k.value||r.kind===k.value)&&terms.every(t=>[r.title,r.text,r.tags.join(' '),r.source.agent].join(' ').toLowerCase().includes(t)));list.replaceChildren();document.querySelector('#count').textContent=rows.length+' of '+data.records.length+' active memories';for(const r of rows.slice(0,200)){const card=document.createElement('article'),title=document.createElement('h2'),meta=document.createElement('small'),id=document.createElement('p'),code=document.createElement('code'),details=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('pre'),source=document.createElement('pre');title.textContent=r.title;meta.textContent=r.kind+' · '+r.provenance+' · '+r.createdAt;code.textContent=r.id;id.append(code);summary.textContent='Read memory and source';text.textContent=r.text;source.textContent=JSON.stringify(r.source,null,2);details.append(summary,text,source);card.append(title,meta,id,details);list.append(card)}if(rows.length>200){const note=document.createElement('p');note.textContent='Showing the first 200 matches. Narrow your search.';list.append(note)}}q.addEventListener('input',render);k.addEventListener('change',render);render();</script></html>`;
}
function writeView(context, output) {
  const html = renderView(context, require('./memory-store').listMemories(context));
  const target = output ? path.resolve(output) : safePath(context.memRoot, path.join('memory-views', crypto.randomUUID() + '.html'));
  safePath(path.dirname(target), path.basename(target));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, html, { flag: 'wx', mode: 0o600 });
  return { path: target, bytes: Buffer.byteLength(html) };
}
module.exports = { renderView, writeView };
