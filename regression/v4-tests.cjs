'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const vm = require('node:vm'); const { webcrypto } = require('node:crypto');
const code = fs.readFileSync(__dirname + '/../dist/main.js','utf8').replace("module.exports=load('main.cjs');", 'module.exports={load};');
const B = class {};
const context = {module:{exports:{}},TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,URL,URLSearchParams,btoa,atob,crypto:webcrypto,require:(name)=>{if(name!=='obsidian')throw Error('forbidden require');return {Plugin:B,Modal:B,PluginSettingTab:B,FuzzySuggestModal:B,Setting:B,MarkdownView:B,Notice:class{}, requestUrl:()=>{throw Error('network forbidden')}};}};
vm.runInNewContext(code, context, {timeout:1000}); const load=context.module.exports.load;
const {LocalVault}=load('local.cjs'); const Main=load('main.cjs'); const enc=new TextEncoder(); const dec=new TextDecoder();
function appFor(paths=[]){const files = new Map(paths.map(p=>[p,{path:p,extension:p.split('.').at(-1),stat:{size:1}}])); return {vault:{getFiles:()=>[...files.values()], getAbstractFileByPath:p=>files.get(p), getFileByPath:p=>files.get(p),readBinary:async()=>enc.encode('text')},metadataCache:{getFirstLinkpathDest:p=>files.get(p)}};}
const {TeamShardedStore,PARAMS,assertManifest}=load('team-sharded-store.cjs');
const {SyncEngine}=load('engine.cjs');const {sha256}=load('drive.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));const sheets=new Map(),files=new Map(),calls=[];let seq=0;
function ranges(id,range){const sh=sheets.get(id);if(range==='Meta!A2:B2')return [['manifest',JSON.stringify(sh.manifest)]];const m=/Payload!A(\d+):B(\d+)/.exec(range);if(m)return Array.from({length:+m[2]-+m[1]+1},(_,i)=>sh.rows[+m[1]-1+i]||[]);throw Error('Unexpected range '+range)}
TeamShardedStore.prototype.call=async function(raw,opt={}){
 const u=new URL(raw), method=opt.method||'GET',body=opt.body;calls.push({url:raw,method});
 if(u.hostname==='www.googleapis.com'){
  if(u.pathname==='/drive/v3/about')return {user:{permissionId:'offline_account',me:true}};
  if(u.pathname==='/drive/v3/files'&&method==='POST'){const id='folder_'+ ++seq;files.set(id,{id,mimeType:body.mimeType,parents:[],capabilities:{canEdit:true}});return clone(files.get(id));}
  const id=u.pathname.split('/').at(-1),f=files.get(id);if(!f)throw Error('Unexpected Drive '+raw);
  if(method==='PATCH')f.parents=[u.searchParams.get('addParents')];return clone(f);
 }
 const tail=u.pathname.replace('/v4/spreadsheets','');
 if(!tail&&method==='POST'){
  const id='spreadsheet_'+ ++seq;sheets.set(id,{spreadsheetId:id,sheets:body.sheets,namedRanges:[],rows:{}});files.set(id,{id,mimeType:'application/vnd.google-apps.spreadsheet',parents:[],capabilities:{canEdit:true}});return {spreadsheetId:id};
 }
 const id=tail.split('/')[1].split(':')[0],sh=sheets.get(id);if(!sh)throw Error('Unknown sheet '+raw);
 if(tail.endsWith('/values:batchUpdate')){for(const d of body.data)if(d.range==='Meta!A1:B2')sh.manifest=JSON.parse(d.values[1][1]);return {};}
 if(tail.endsWith('/values:batchGet'))return {valueRanges:u.searchParams.getAll('ranges').map(r=>({values:ranges(id,r)}))};
 if(tail.endsWith(':batchUpdate')){
  for(const r of body.requests){if(r.addNamedRange){const nr=r.addNamedRange.namedRange;if(sh.namedRanges.some(x=>x.name===nr.name)){const e=Error('Duplicate');e.status=400;throw e;}}
  }
  for(const r of body.requests){if(r.addNamedRange)sh.namedRanges.push(clone(r.addNamedRange.namedRange));if(r.updateCells)r.updateCells.rows.forEach((row,i)=>{sh.rows[r.updateCells.range.startRowIndex+i]=row.values.map(v=>v.userEnteredValue.stringValue)});}
  return {};
 }
 if(tail.includes('/values/'))return {values:ranges(id,decodeURIComponent(tail.split('/values/')[1]))};
 if(tail===`/${id}`)return clone(sh);
 throw Error('Unexpected Sheets request '+raw);
};
function vault(entries){const mem=new Map(Object.entries(entries).map(([k,v])=>[k,enc.encode(v)])),dirs=new Set([...mem.keys()].flatMap(p=>p.split('/').slice(0,-1)));const f=p=>mem.has(p)?{path:p,extension:p.split('.').at(-1),stat:{size:mem.get(p).length}}:null;
 const app={vault:{getFiles:()=>[...mem.keys()].filter(p=>!p.startsWith('.easy-sync/')).map(f),getFileByPath:f,getAbstractFileByPath:p=>dirs.has(p)?{path:p,children:[]}:f(p),readBinary:async x=>mem.get(x.path),createFolder:async p=>dirs.add(p),createBinary:async(p,b)=>mem.set(p,new Uint8Array(b)),process:async(x,fn)=>mem.set(x.path,enc.encode(fn(dec.decode(mem.get(x.path))))),rename:async(x,to)=>{mem.set(to,mem.get(x.path));mem.delete(x.path)},adapter:{exists:async p=>mem.has(p)||dirs.has(p),mkdir:async p=>dirs.add(p),readBinary:async p=>mem.get(p),writeBinary:async(p,b)=>mem.set(p,new Uint8Array(b))}},metadataCache:{getFirstLinkpathDest:p=>f(p)},workspace:{getActiveFile:()=>null}};return {app,mem};}
(async()=>{
 let intent=null;const info=await TeamShardedStore.provision({request:()=>{throw Error('NETWORK FORBIDDEN')},getAccessToken:()=>{throw Error('AUTH FORBIDDEN')},readIntent:async()=>intent,writeIntent:async v=>{intent=clone(v)},name:'Offline scoped'});
 assert.equal(intent,null);assert.equal(info.version,4);assert.equal(info.pathProtocol,'project-relative-v1');assert.equal(sheets.size,9);for(const sh of sheets.values()){assert.equal(sh.manifest.schema,3);assert.equal(sh.manifest.namespace,info.id)}console.log('PASS new v4 provisioning creates scoped root and all eight scoped shards');
 const before=calls.length;await assert.rejects(()=>TeamShardedStore.provision({readIntent:async()=>({schema:1,name:'Offline scoped',vaultId:'legacyvault'}),writeIntent:async()=>{throw Error('MUST NOT WRITE')},name:'Offline scoped'}));assert.equal(calls.length,before);console.log('PASS legacy provisioning intent rejected without I/O');
 const root=sheets.get(info.id).manifest;const shard=sheets.get(info.shardIds[0]).manifest;const oldSchema=shard.schema;shard.schema=2;
 const legacyRecord={opId:'legacy_op',spreadsheetId:'legacy_sheet',kind:'D',slot:0,accountId:'offline_account'};
 const journalPlugin=Object.create(Main.prototype);journalPlugin.pluginData={v4Operations:{legacy_op:legacyRecord}};journalPlugin.diagnosticWrite=Promise.resolve();journalPlugin.saveData=async()=>{};journalPlugin.v4Auth={accessToken:()=>{throw Error('AUTH FORBIDDEN')}};journalPlugin.setProgress=()=>{};
 const makeRemote=()=>journalPlugin.drive({...info,kind:'team',version:4});
 await assert.rejects(()=>makeRemote().assertScopeProtocol());shard.schema=oldSchema;console.log('PASS mixed legacy/scoped shards rejected');
 const v1=vault({'Alpha/a.md':'[[Alpha/b.md]]','Alpha/b.md':'team note','Private/secret.md':'PRIVATE_SENTINEL_abc'}),v2=vault({'Beta/keep.md':'second note','Private/b.md':'PRIVATE_SENTINEL_def'});
 const state1={},state2={};let ids=0;const engine=(v,scope,state)=>new SyncEngine({remote:makeRemote(),local:new LocalVault(v.app,{scopePath:scope}),state,saveState:async()=>{},hash:sha256,randomId:()=>`test_${++ids}`});
 await engine(v1,'Alpha',state1).sync();await engine(v2,'Beta',state2).sync();await engine(v1,'Alpha',state1).sync();
 assert.equal(dec.decode(v2.mem.get('Beta/a.md')),'[[Beta/b.md]]');assert.equal(dec.decode(v1.mem.get('Alpha/keep.md')),'second note');assert.equal(dec.decode(v1.mem.get('Private/secret.md')),'PRIVATE_SENTINEL_abc');assert.equal(dec.decode(v2.mem.get('Private/b.md')),'PRIVATE_SENTINEL_def');
 const remote=makeRemote();await remote.assertAccess();const events=await remote.listEvents();assert(events.length>=3);assert(events.every(e=>!e.path.startsWith('Alpha/')&&!e.path.startsWith('Beta/')&&!e.path.startsWith('Private/')));for(const e of events){if(e.hash)assert(!dec.decode(await remote.getBlob(e.hash)).includes('PRIVATE_SENTINEL'))}console.log('PASS real v4 store slots/commits roundtrip between two differently scoped vaults without private bytes');
 const verified=await engine(v2,'Beta',state2).verify();assert.equal(verified.files,3);console.log('PASS v4 remote blob and snapshot verification');
 const snap=JSON.stringify([...sheets.values()]);await assert.rejects(()=>engine(v1,'Changed',state1).sync(),/another scope/);assert.equal(JSON.stringify([...sheets.values()]),snap);console.log('PASS changed local scope cannot replay bound state');
 const saved=root.schema;root.schema=2;await assert.rejects(()=>engine(v1,'Alpha',state1).sync());root.schema=saved;console.log('PASS legacy v4 root rejected');
 const unbound={baseline:{},outbox:[{event:{id:'legacy',path:'Private/secret.md',hash:null,parents:[]}}]};const beforeJournal=JSON.stringify(unbound),beforeRemote=JSON.stringify([...sheets.values()]);await assert.rejects(()=>engine(v1,'Alpha',unbound).sync(),/Unbound legacy/);assert.equal(JSON.stringify(unbound),beforeJournal);assert.equal(JSON.stringify([...sheets.values()]),beforeRemote);console.log('PASS unbound legacy outbox preserved without replay');
 const namespace=root.namespace;root.namespace='other_project';await assert.rejects(()=>engine(v1,'Alpha',state1).sync());root.namespace=namespace;console.log('PASS namespace substitution rejected');
 const at=calls.length;await engine(v2,'Beta',state2).sync();const delta=calls.slice(at);assert.equal(delta.filter(c=>c.method!=='GET').length,0);assert(delta.length<=34,`No-op read budget exceeded: ${delta.length}`);const sheetsReads=delta.filter(c=>c.url.includes('sheets.googleapis.com')).length;assert(sheetsReads<=25);console.log(`PASS three-note no-op budget: ${delta.length} reads (${sheetsReads} Sheets), zero writes`);
 const v3=vault({'Private/untouched.md':'private'});const blocked=new SyncEngine({remote:makeRemote(),local:new LocalVault(v3.app,{scopePath:'Gamma'}),state:{},saveState:async()=>{},hash:sha256,randomId:()=>`test_${++ids}`,progress:p=>{if(p.phase==='reconciling')root.schema=2}});const beforeFiles=JSON.stringify([...v3.mem]);await assert.rejects(()=>blocked.sync());root.schema=3;assert.equal(JSON.stringify([...v3.mem]),beforeFiles);console.log('PASS fresh pre-mutation access detects mid-pass manifest downgrade and prevents local writes');
 assert.equal(JSON.stringify(journalPlugin.pluginData.v4Operations),JSON.stringify({legacy_op:legacyRecord}));assert.equal(journalPlugin.v4OperationJournal(info.id).pendingAll().length,0);console.log('PASS actual Main.drive per-root operation journal allows new project, legacy pending operations preserved');
 const j1=journalPlugin.v4OperationJournal(info.id),j2=journalPlugin.v4OperationJournal('another_root');await j1.stage({opId:'same_id',spreadsheetId:info.id});await j2.stage({opId:'same_id',spreadsheetId:'another_root'});assert.equal(j1.pending('same_id').spreadsheetId,info.id);assert.equal(j2.pending('same_id').spreadsheetId,'another_root');await j1.ack('same_id');assert.equal(j1.pending('same_id'),null);assert.equal(j2.pending('same_id').spreadsheetId,'another_root');console.log('PASS equal operation IDs isolated across projects, acknowledging one preserves other');
 console.log('13/13 v4 protocol/provisioning/roundtrip scenarios passed');
})().catch(e=>{console.error(e);process.exitCode=1});
