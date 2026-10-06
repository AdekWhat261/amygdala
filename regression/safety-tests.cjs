'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const vm = require('node:vm'); const { webcrypto } = require('node:crypto');
const code = fs.readFileSync(__dirname + '/../dist/main.js','utf8').replace("module.exports=load('main.cjs');", 'module.exports={load};');
const B = class {};
const context = {module:{exports:{}},TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,URL,crypto:webcrypto,require:(name)=>{if(name!=='obsidian')throw Error('forbidden require');return {Plugin:B,Modal:B,PluginSettingTab:B,FuzzySuggestModal:B,Setting:B,MarkdownView:B,Notice:class{}, requestUrl:()=>{throw Error('network forbidden')}};}};
vm.runInNewContext(code, context, {timeout:1000}); const load=context.module.exports.load;
const {LocalVault}=load('local.cjs'); const Main=load('main.cjs'); const enc=new TextEncoder(); const dec=new TextDecoder();
function appFor(paths=[]){const files = new Map(paths.map(p=>[p,{path:p,extension:p.split('.').at(-1),stat:{size:1}}])); return {vault:{getFiles:()=>[...files.values()], getAbstractFileByPath:p=>files.get(p), getFileByPath:p=>files.get(p),readBinary:async()=>enc.encode('text')},metadataCache:{getFirstLinkpathDest:p=>files.get(p)}};}
const tests=[]; const test=(name,run)=>tests.push({name,run});
const local=new LocalVault(appFor(['Team/a.md','Private/secret.md']),{scopePath:'Team'});
for(const target of ['../Private/secret.md','/etc/passwd','foo/../../x','a\\b'])test('Reject traversal '+target,()=>assert.throws(()=>local.localPath(target)));
for(const input of ['[private][s]\n\n[s]: Private/secret.md','<a href="Private/secret.md">private</a>','[private](Private%2Fsecret.md)','[[Private/secret.md]]','![[Private/secret.md]]'])test('Reject unsafe Markdown '+input,()=>assert.throws(()=>local.mapMarkdown(enc.encode(input),'remote','Team/a.md')));
test('Map valid inline project link',()=>assert.equal(dec.decode(local.mapMarkdown(enc.encode('[[Team/a.md]]'),'remote','Team/a.md')),'[[a.md]]'));
test('External HTTPS links remain allowed',()=>assert.equal(dec.decode(local.mapMarkdown(enc.encode('[site](https://example.com/a%20b)'),'remote','Team/a.md')),'[site](https://example.com/a%20b)'));
test('Incoming unresolved basename stays inside scope despite private collision',()=>{
 const app=appFor(['Private/z.md']);app.metadataCache.getFirstLinkpathDest=()=>app.vault.getFileByPath('Private/z.md');
 const l=new LocalVault(app,{scopePath:'Team'});assert.equal(dec.decode(l.mapMarkdown(enc.encode('[[z.md]]'),'local','Team/a.md')),'[[Team/z.md]]');
});
test('Ignore invalid private filenames before validation',async()=>{
 const s=await new LocalVault(appFor(['Team/a.md','Private/question?.md']),{scopePath:'Team'}).scan();assert.deepEqual(Object.keys(s),['a.md']);
});
function configPlugin({set,save,get,load}={}) {
 const c={newFileLocation:'folder',newFileFolderPath:'Old'},disk={value:'Old'};const p=Object.create(Main.prototype);p.defaultNoteFolderPath='Old';
 p.app={vault:{getAbstractFileByPath:()=>({children:[]}),getRoot:()=>({children:[]}),getConfig:k=>get?get(k,c):c[k],setConfig:(k,v)=>set?set(k,v,c):c[k]=v},loadLocalStorage:()=>load?load(disk):disk.value,saveLocalStorage:(k,v)=>save?save(v,disk):disk.value=v};return {p,c,disk};
}
test('Setter succeeds only with effective and preference readback',()=>{const {p,c,disk}=configPlugin();assert.equal(p.applyDefaultNoteFolder('New',{notify:false}),true);assert.equal(c.newFileFolderPath,'New');assert.equal(disk.value,'New');assert.equal(p.defaultNoteFolderPath,'New')});
test('Root selection effective configuration',()=>{const {p,c,disk}=configPlugin();assert.equal(p.applyDefaultNoteFolder('',{notify:false}),true);assert.equal(c.newFileFolderPath,'/');assert.equal(c.newFileLocation,'root');assert.equal(disk.value,'')});
test('Unsupported unreadable hooks fail without mutation',()=>{const {p,c}=configPlugin();delete p.app.vault.getConfig;assert.equal(p.applyDefaultNoteFolder('New',{notify:false}),false);assert.equal(c.newFileFolderPath,'Old')});
test('Second setter throws: independent rollback restores path',()=>{const {p,c,disk}=configPlugin({set:(k,v,c)=>{if(k==='newFileLocation')throw Error('unsupported');c[k]=v}});assert.equal(p.applyDefaultNoteFolder('New',{notify:false}),false);assert.equal(c.newFileFolderPath,'Old');assert.equal(disk.value,'Old');assert.equal(p.defaultNoteFolderPath,'Old');assert.match(p.lastDefaultFolderError,/restored and verified/)});
test('Silent setter fails readback',()=>{const {p,c}=configPlugin({set:()=>{}});assert.equal(p.applyDefaultNoteFolder('New',{notify:false}),false);assert.equal(c.newFileFolderPath,'Old');assert.equal(p.defaultNoteFolderPath,'Old')});
test('Preference failure restores effective config',()=>{const {p,c}=configPlugin({save:()=>{throw Error('disk failure')}});assert.equal(p.applyDefaultNoteFolder('New',{notify:false}),false);assert.equal(c.newFileFolderPath,'Old');assert.equal(p.defaultNoteFolderPath,'Old')});
test('Silent preference write rolls back config',()=>{const {p,c}=configPlugin({save:()=>{}});assert.equal(p.applyDefaultNoteFolder('New',{notify:false}),false);assert.equal(c.newFileFolderPath,'Old')});
test('Mutate then throw storage rolls back both stores',()=>{const {p,c,disk}=configPlugin({save:(v,d)=>{d.value=v;if(v==='New')throw Error('postwrite')}});assert.equal(p.applyDefaultNoteFolder('New',{notify:false}),false);assert.equal(c.newFileFolderPath,'Old');assert.equal(disk.value,'Old')});
test('Unrecoverable rollback explicitly reported',()=>{let calls=0;const {p}=configPlugin({set:(k,v,c)=>{if(++calls>1)throw Error('failure');c[k]=v}});assert.equal(p.applyDefaultNoteFolder('New',{notify:false}),false);assert.match(p.lastDefaultFolderError,/rollback could not be verified/);assert.equal(p.defaultNoteFolderPath,'Old')});
const {SyncEngine}=load('engine.cjs');const {sha256}=load('drive.cjs');
for(const method of ['sync','flush','verify','listConflicts','resolveConflict']) test('Scoped '+method+' blocked before remote/local mutation',async()=>{
 let calls=0;const remote={listEvents:async()=>{calls++;throw Error('unexpected I/O')}};
 const state={baseline:{'Team/a.md':{hash:null,heads:['old']}},outbox:[{event:{id:'pending',path:'Private/secret.md',hash:null,parents:[]}}]};const before=JSON.stringify(state);
 const e=new SyncEngine({remote,local,state,saveState:async()=>{calls++},randomId:()=> 'new',hash:sha256});
 await assert.rejects(()=>e[method]('a.md','id'),/scope protocol is not verified/);assert.equal(calls,0);assert.equal(JSON.stringify(state),before);
});
test('Unscoped empty personal sync remains operational',async()=>{
 const remote={listEvents:async()=>[]};const l={scopePath:null,scan:async()=>Object.create(null)};const e=new SyncEngine({remote,local:l,state:{},saveState:async()=>{},hash:sha256,randomId:()=> 'id'});const r=await e.sync();assert.equal(r.applied.length,0);
});
test('DeviceState persists binding through save and reload',async()=>{
 const {DeviceState}=load('local.cjs');const stores={state:new Map(),outbox:new Map()};
 const db={transaction:()=>{const tx={objectStore:name=>({get:k=>{const r={};queueMicrotask(()=>{r.result=stores[name].get(k);r.onsuccess?.()});return r},put:(v,k)=>stores[name].set(k,structuredClone(v)),delete:k=>stores[name].delete(k)}),abort:()=>tx.onabort?.()};setTimeout(()=>tx.oncomplete?.(),0);return tx}};
 const saved={baseline:{'a.md':{hash:null,heads:[]}},outbox:[],scopeBinding:{namespace:'spreadsheet_10',pathProtocol:'project-relative-v1',localScope:'Team'}};
 const d=new DeviceState('fake');d.db=async()=>db;await d.save(saved);const again=new DeviceState('fake');again.db=async()=>db;const got=await again.load();assert.equal(JSON.stringify(got.scopeBinding),JSON.stringify(saved.scopeBinding));assert.equal(JSON.stringify(got.baseline),JSON.stringify(saved.baseline));
});
for(const input of ['[p](..&#47;Private&#47;secret.md)','![p](..&#x2f;Private&#x2f;image.png)','[p](..&sol;Private&sol;secret.md)'])for(const direction of ['local','remote'])test('Reject entity path '+direction+' '+input,()=>assert.throws(()=>local.mapMarkdown(enc.encode(input),direction,'Team/a.md'),/parser-backed/));
test('Reject outgoing reserved wiki target',()=>assert.throws(()=>local.mapMarkdown(enc.encode('[[Team/.obsidian/config.json]]'),'remote','Team/a.md'),/reserved/));
test('Reject outgoing reserved Canvas target',()=>assert.throws(()=>local.mapCanvas(enc.encode(JSON.stringify({nodes:[{type:'file',file:'Team/.obsidian/config.json'}]})),'remote','Team/a.canvas'),/reserved/));
(async()=>{let passed=0;for(const t of tests){try{await t.run();passed++;console.log('PASS '+t.name)}catch(e){console.error('FAIL '+t.name,e);process.exitCode=1}} console.log(`${passed}/${tests.length} passed`);})();
