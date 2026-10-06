'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const vm = require('node:vm'); const { webcrypto } = require('node:crypto');
const code = fs.readFileSync(__dirname + '/../dist/main.js','utf8').replace("module.exports=load('main.cjs');", 'module.exports={load};');
const B = class {};
const context = {module:{exports:{}},TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,URL,URLSearchParams,btoa,atob,crypto:webcrypto,require:(name)=>{if(name!=='obsidian')throw Error('forbidden require');return {Plugin:B,Modal:B,PluginSettingTab:B,FuzzySuggestModal:B,Setting:B,MarkdownView:B,Notice:class{}, requestUrl:()=>{throw Error('network forbidden')}};}};
vm.runInNewContext(code, context, {timeout:1000}); const load=context.module.exports.load;
const {LocalVault}=load('local.cjs'); const Main=load('main.cjs'); const enc=new TextEncoder(); const dec=new TextDecoder();
function appFor(paths=[]){const files = new Map(paths.map(p=>[p,{path:p,extension:p.split('.').at(-1),stat:{size:1}}])); return {vault:{getFiles:()=>[...files.values()], getAbstractFileByPath:p=>files.get(p), getFileByPath:p=>files.get(p),readBinary:async()=>enc.encode('text')},metadataCache:{getFirstLinkpathDest:p=>files.get(p)}};}
function vault(entries){const mem=new Map(Object.entries(entries).map(([k,v])=>[k,enc.encode(v)])),dirs=new Set([...mem.keys()].flatMap(p=>p.split('/').slice(0,-1)));const f=p=>mem.has(p)?{path:p,extension:p.split('.').at(-1),stat:{size:mem.get(p).length}}:null;
 const app={vault:{getFiles:()=>[...mem.keys()].filter(p=>!p.startsWith('.easy-sync/')).map(f),getFileByPath:f,getAbstractFileByPath:p=>dirs.has(p)?{path:p,children:[]}:f(p),readBinary:async x=>mem.get(x.path),createFolder:async p=>dirs.add(p),createBinary:async(p,b)=>mem.set(p,new Uint8Array(b)),process:async(x,fn)=>mem.set(x.path,enc.encode(fn(dec.decode(mem.get(x.path))))),rename:async(x,to)=>{mem.set(to,mem.get(x.path));mem.delete(x.path)},adapter:{exists:async p=>mem.has(p)||dirs.has(p),mkdir:async p=>dirs.add(p),readBinary:async p=>mem.get(p),writeBinary:async(p,b)=>mem.set(p,new Uint8Array(b))}},metadataCache:{getFirstLinkpathDest:p=>f(p)},workspace:{getActiveFile:()=>null}};return {app,mem};}
const {TeamSheetStore}=load('team-sheet-store.cjs'),{SyncEngine}=load('engine.cjs'),{sha256}=load('drive.cjs');
const sheets=new Map(),files=new Map(),calls=[];let seq=0,passed=0;const clone=x=>JSON.parse(JSON.stringify(x));
const pass=s=>{passed++;console.log('PASS '+s)};
function rows(id,r){const m=/^([^!]+)!([A-Z]+)(\d*)?:([A-Z]+)(\d*)?$/.exec(r);if(!m)throw Error('bad range '+r);return (sheets.get(id).tabs[m[1]]||[]).slice((+m[3]||1)-1,+m[5]||undefined)}
async function api(raw,opt={}){
 const u=new URL(raw),method=opt.method||'GET',body=opt.body?JSON.parse(opt.body):null;calls.push({method,url:raw});
 if(u.hostname==='www.googleapis.com'){
  if(u.pathname==='/drive/v3/files'&&method==='POST'){const id='folder_'+ ++seq;files.set(id,{id,mimeType:body.mimeType,parents:[],capabilities:{canEdit:true}});return clone(files.get(id))}
  const id=u.pathname.split('/').at(-1),f=files.get(id);if(!f)throw Error('unknown Drive '+raw);if(method==='PATCH')f.parents=[u.searchParams.get('addParents')];return clone(f);
 }
 const tail=u.pathname.replace('/v4/spreadsheets','');
 if(!tail&&method==='POST'){const id='sheet_id_'+ ++seq;sheets.set(id,{tabs:{}});files.set(id,{id,mimeType:'application/vnd.google-apps.spreadsheet',parents:[],capabilities:{canEdit:true}});return {spreadsheetId:id}}
 const id=tail.split('/')[1],sh=sheets.get(id);if(!sh)throw Error('unknown sheet '+raw);
 if(tail.endsWith('/values:batchUpdate')){for(const d of body.data)sh.tabs[d.range.split('!')[0]]=clone(d.values);return {}}
 if(tail.endsWith('/values:batchGet'))return {valueRanges:u.searchParams.getAll('ranges').map(r=>({values:rows(id,r)}))};
 if(tail.includes('/values/')){const range=decodeURIComponent(tail.split('/values/')[1]);if(range.endsWith(':append')){const tab=range.split('!')[0],data=sh.tabs[tab],start=data.length+1;data.push(...clone(body.values));return {updates:{updatedRange:`${tab}!A${start}:D${data.length}`}}}return {values:clone(rows(id,range))}}
 throw Error('unexpected '+raw);
}
TeamSheetStore.prototype.call=api;
const fresh=spreadsheetId=>new TeamSheetStore({spreadsheetId,request:()=>{throw Error('NETWORK FORBIDDEN')},getAccessToken:()=>{throw Error('AUTH FORBIDDEN')}});
const oldContext={...context,module:{exports:{}}};vm.runInNewContext(fs.readFileSync(__dirname+'/../test-fixtures/authentic-beta7-main.js','utf8').replace("module.exports=load('main.cjs');",'module.exports={load};'),oldContext,{timeout:1000});
const OldSheet=oldContext.module.exports.load('team-sheet-store.cjs').TeamSheetStore;OldSheet.prototype.call=api;
(async()=>{
const r=fresh(),info=await r.createTeamVault('Independent v3');const meta=sheets.get(info.id).tabs.Meta;assert.equal(JSON.parse(meta[1][1]).schema,2);assert.equal(info.namespace,info.id);pass('real v3 creation emits schema2 scoped manifest');
await assert.rejects(()=>new OldSheet({spreadsheetId:info.id}).teamInfo());pass('authentic old v3 client rejects new manifest');
const saved=meta[1][1];for(const change of [{schema:1},{namespace:'other_namespace'},{pathProtocol:'whole-vault'}]){meta[1][1]=JSON.stringify({...JSON.parse(saved),...change});const n=calls.filter(c=>c.method!=='GET').length;await assert.rejects(()=>fresh(info.id).assertScopeProtocol());assert.equal(calls.filter(c=>c.method!=='GET').length,n)}meta[1][1]=saved;pass('legacy schema and tampered marker/namespace rejected without writes');
const a=vault({'Alpha/a.md':'[[Alpha/b.md]]','Alpha/b.md':'team shared','Alpha/map.canvas':JSON.stringify({nodes:[{id:'f',type:'file',file:'Alpha/b.md'},{id:'t',type:'text',text:'[[Alpha/b.md]]'},{id:'g',type:'group',background:'Alpha/b.md'}]}),'Private/secret.md':'PRIVATE_SENTINEL_1'}),b=vault({'Beta/own.md':'peer note','Private/b.md':'PRIVATE_SENTINEL_2'});let rev=0;const stA={},stB={};
const engine=(v,scope,state)=>new SyncEngine({remote:fresh(info.id),local:new LocalVault(v.app,{scopePath:scope}),state,saveState:async()=>{},randomId:()=>`v3_${++rev}`,hash:sha256});
await engine(a,'Alpha',stA).sync();await engine(b,'Beta',stB).sync();await engine(a,'Alpha',stA).sync();await engine(b,'Beta',stB).sync();assert.equal(dec.decode(b.mem.get('Beta/a.md')),'[[Beta/b.md]]');const canvas=JSON.parse(dec.decode(b.mem.get('Beta/map.canvas')));assert.equal(canvas.nodes[0].file,'Beta/b.md');assert.equal(canvas.nodes[1].text,'[[Beta/b.md]]');assert.equal(canvas.nodes[2].background,'Beta/b.md');pass('two v3 clients remap Markdown and Canvas file/text/background nodes');
const events=await fresh(info.id).listEvents();assert.equal(events.length,4);assert(events.every(e=>!/^Alpha\/|^Beta\/|^Private\//.test(e.path)));for(const e of events)assert(!dec.decode(await fresh(info.id).getBlob(e.hash)).includes('PRIVATE_SENTINEL'));assert.equal(dec.decode(a.mem.get('Private/secret.md')),'PRIVATE_SENTINEL_1');assert.equal(dec.decode(b.mem.get('Private/b.md')),'PRIVATE_SENTINEL_2');assert.equal((await engine(a,'Alpha',stA).verify()).files,4);assert.equal((await engine(b,'Beta',stB).verify()).files,4);pass('stable roundtrip hashes, four events only, private bytes absent, verify passes both clients');
for(const state of [{baseline:{},outbox:[{event:{id:'pending',path:'secret.md',hash:null,parents:[]}}]},{...stA,scopeBinding:{...stA.scopeBinding,namespace:'foreign_project'}},{...stA,scopeBinding:{...stA.scopeBinding,localScope:'Changed'}}]){const snap=JSON.stringify([...sheets]);await assert.rejects(()=>engine(a,'Alpha',state).sync());assert.equal(JSON.stringify([...sheets]),snap)}pass('unbound outbox and mismatched namespace/scope cannot write');
meta[1][1]=JSON.stringify({...JSON.parse(saved),schema:1});const snap=JSON.stringify([...sheets]);await assert.rejects(()=>engine(a,'Alpha',stA).sync());assert.equal(JSON.stringify([...sheets]),snap);meta[1][1]=saved;pass('legacy downgrade blocked on reused state, remote unchanged');
console.log(`${passed}/${passed} independent v3 scenarios passed`);
})().catch(e=>{console.error(e);process.exitCode=1});
