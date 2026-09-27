'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {SyncEngine} = require('../src/engine.cjs');
const {conflictPath} = require('../src/journal.cjs');
const encode = text=>new TextEncoder().encode(text);
const hash = async bytes=>createHash('sha256').update(bytes).digest('hex');
let sequence = 0;
function remote() {
  return {events:[],blobs:new Map(),async listEvents(){return structuredClone(this.events);},async putEvent(e){if (!this.events.some(x=>x.id===e.id)) this.events.push(structuredClone(e));},async putBlob(h,b){this.blobs.set(h,b.slice());},async getBlob(h){return this.blobs.get(h)?.slice();}};
}
function local(initial={}) {
  return {files:new Map(Object.entries(initial).map(([p,s])=>[p,encode(s)])),conflictFiles:new Map(),recovery:[],async scan(){return Object.fromEntries(await Promise.all([...this.files].map(async ([p,b])=>[p,await hash(b)])));},async read(p){return this.files.get(p)?.slice() ?? null;},async writeIfUnchanged(p,b,expected){const old=await this.read(p); if ((old ? await hash(old) : null)!==expected) return false; if (old && await hash(old)!==await hash(b)) this.recovery.push([p,old]); this.files.set(p,b.slice());return true;},async removeIfUnchanged(p,expected){const b=await this.read(p);if (!b || await hash(b)!==expected) return false;this.recovery.push([p,b]);this.files.delete(p);return true;},conflictPath(p,h){return `.easy-sync/conflicts/${h}/${p}`;},async writeConflict(p,h,b){this.conflictFiles.set(this.conflictPath(p,h),b.slice());return this.conflictPath(p,h);},async readConflict(p,h){return this.conflictFiles.get(this.conflictPath(p,h))?.slice()??null;},text(p){return new TextDecoder().decode(this.files.get(p));}};
}
function engine(r,l,state={baseline:{}},saveState=async()=>{},actor=null) {return new SyncEngine({remote:r,local:l,state,saveState,hash,randomId:()=>`e${++sequence}`,actor,deviceId:actor?'device_12345678':null});}
test('first merge preserves both nonempty vaults and divergent same-name notes',async()=>{
 const r=remote(),a=local({'a.md':'one','same.md':'alpha'}),b=local({'b.md':'two','same.md':'beta'});
 const ea=engine(r,a),eb=engine(r,b); await ea.sync();await eb.sync();await ea.sync();
 assert.equal(a.text('b.md'),'two');assert.equal(b.text('a.md'),'one');
 assert.equal(a.text('same.md'),'alpha');
 assert.equal(new TextDecoder().decode(await a.readConflict('same.md',await hash(encode('beta')))),'beta');
});
test('offline edit versus edit keeps both revisions with stable conflict name',async()=>{
 const r=remote(),a=local({'n.md':'base'}),b=local();const ea=engine(r,a),eb=engine(r,b);await ea.sync();await eb.sync();
 a.files.set('n.md',encode('left'));b.files.set('n.md',encode('right'));await ea.sync();const result=await eb.sync();
 assert.equal(result.conflicts.length,1);const count=b.conflictFiles.size;await eb.sync();assert.equal(b.conflictFiles.size,count);
 const variants=new Set([b.text('n.md'),...await Promise.all([...b.conflictFiles.values()].map(async value=>new TextDecoder().decode(value)))]);
 assert.deepEqual(variants,new Set(['left','right']));
});
test('team conflicts show authors and resolve both heads into one new revision',async()=>{
 const r=remote(),a=local({'n.md':'base'}),b=local(),ea=engine(r,a,undefined,undefined,{actorId:'perm-alice',actorName:'Alice'}),eb=engine(r,b,undefined,undefined,{actorId:'perm-bob',actorName:'Bob'});
 await ea.sync();await eb.sync();a.files.set('n.md',encode('from Alice'));b.files.set('n.md',encode('from Bob'));await ea.sync();await eb.sync();
 const conflicts=await eb.listConflicts();assert.equal(conflicts.length,1);assert.deepEqual(new Set(conflicts[0].variants.map(v=>v.actorName)),new Set(['Alice','Bob']));
 const chosen=conflicts[0].variants.find(v=>v.actorName==='Bob'),heads=r.events.filter(e=>e.path==='n.md'&&e.parents.length===1);
 await eb.resolveConflict('n.md',chosen.id);const resolved=r.events.find(e=>e.path==='n.md'&&e.hash===chosen.hash&&e.parents.length===2);
 assert.ok(resolved);assert.deepEqual(new Set(resolved.parents),new Set(heads.map(e=>e.id)));
 await eb.sync();assert.equal((await eb.listConflicts()).length,0);assert.equal(b.text('n.md'),'from Bob');
});
test('manual merge revision uses both active heads as parents',async()=>{
 const r=remote(),a=local(),h1=await hash(encode('left')),h2=await hash(encode('right'));
 r.blobs.set(h1,encode('left'));r.blobs.set(h2,encode('right'));r.events=[{id:'left-head',path:'n.md',hash:h1,parents:[]},{id:'right-head',path:'n.md',hash:h2,parents:[]}];
 const e=engine(r,a);await e.sync();await e.resolveConflict('n.md','manual',encode('merged'));
 const mergedHash=await hash(encode('merged')),result=r.events.find(event=>event.hash===mergedHash);assert.deepEqual(new Set(result.parents),new Set(['left-head','right-head']));
 await e.sync();assert.equal(a.text('n.md'),'merged');assert.equal((await e.listConflicts()).length,0);
});
test('offline edit versus delete preserves edit',async()=>{
 const r=remote(),a=local({'n.md':'base'}),b=local();const ea=engine(r,a),eb=engine(r,b);await ea.sync();await eb.sync();
 a.files.delete('n.md');b.files.set('n.md',encode('edit'));await ea.sync();await eb.sync();await ea.sync();assert.equal(a.text('n.md'),'edit');assert.equal(b.text('n.md'),'edit');
});
test('remote tombstone removes only unchanged tracked note with recovery',async()=>{
 const r=remote(),a=local({'n.md':'base'}),b=local();const ea=engine(r,a),eb=engine(r,b);await ea.sync();await eb.sync();a.files.delete('n.md');await ea.sync();await eb.sync();assert.equal(b.files.has('n.md'),false);assert.equal(b.recovery.length,1);
});
test('lost upload acknowledgement retries durable identical revision after restart',async()=>{
 const r=remote(),a=local({'n.md':'old'});let saved;const original=r.putEvent;r.putEvent=async function(e){await original.call(this,e);throw new Error('lost ack');};
 const ea=engine(r,a,undefined,async state=>{saved=structuredClone(state);});await assert.rejects(ea.sync(),/lost ack/);assert.equal(saved.outbox.length,1);
 const id=saved.outbox[0].event.id;a.files.set('n.md',encode('new'));r.putEvent=original;await engine(r,a,saved).sync();assert.equal(r.events.filter(e=>e.id===id).length,1);assert.equal(r.events.length,2);assert.equal(a.text('n.md'),'new');assert.deepEqual(r.events[1].parents,[id]);
});
test('corrupt remote binary is never written',async()=>{
 const r=remote(),a=local({'img.png':'binary'});await engine(r,a).sync();r.getBlob=async()=>encode('corrupt');const b=local();await assert.rejects(engine(r,b).sync(),/integrity/);assert.equal(b.files.size,0);
});
test('local edit during downloading cannot be overwritten',async()=>{
 const r=remote(),a=local({'n.md':'base'}),b=local();const ea=engine(r,a),eb=engine(r,b);await ea.sync();await eb.sync();a.files.set('n.md',encode('remote edit'));await ea.sync();
 const original=r.getBlob;r.getBlob=async function(h){b.files.set('n.md',encode('typing'));return original.call(this,h);};const result=await eb.sync();const typingHash=await hash(encode('typing'));assert.ok(b.text('n.md')==='typing'||await b.readConflict('n.md',typingHash));assert.ok(result.deferred.includes('n.md'));r.getBlob=original;await eb.sync();assert.ok([...b.files.values()].some(v=>new TextDecoder().decode(v)==='typing')||await b.readConflict('n.md',typingHash));
});
test('local edit between scan and upload defers stale revision',async()=>{
 const r=remote(),a=local({'n.md':'old'});const original=a.read;a.read=async function(p){this.files.set(p,encode('typing'));return original.call(this,p);};const result=await engine(r,a).sync();assert.equal(r.events.length,0);assert.ok(result.deferred.includes('n.md'));assert.equal(a.text('n.md'),'typing');
});
test('incomplete parent listing fails before mutation',async()=>{
 const r=remote(),a=local({'n.md':'safe'});r.events=[{id:'child',path:'n.md',hash:null,parents:['missing']}];await assert.rejects(engine(r,a).sync(),/Missing parent/);assert.equal(a.text('n.md'),'safe');assert.equal(r.events.length,1);
});
test('concurrent sync calls share one flight',async()=>{
 const r=remote(),a=local({'n.md':'safe'}),e=engine(r,a);const p=e.sync();assert.equal(e.sync(),p);await p;assert.equal(r.events.length,1);
});
test('missing previously known cloud history fails closed after restart',async()=>{
 const r=remote(),a=local({'n.md':'safe'}),e=engine(r,a);await e.sync();const state=structuredClone(e.state);r.events=[];await assert.rejects(engine(r,a,state).sync(),/history missing/);assert.equal(a.text('n.md'),'safe');assert.equal(r.events.length,0);
});
test('persistence failure prevents upload, including subsequent retry',async()=>{
 const r=remote(),a=local({'n.md':'safe'}),e=engine(r,a,undefined,async()=>{throw new Error('disk full');});await assert.rejects(e.sync(),/disk full/);await assert.rejects(e.sync(),/disk full/);assert.equal(r.events.length,0);assert.equal(r.blobs.size,0);
});
test('conflict destination containing user content is never overwritten',async()=>{
 const r=remote();const h1=await hash(encode('one')),h2=await hash(encode('two'));r.blobs.set(h1,encode('one'));r.blobs.set(h2,encode('two'));r.events=[{id:'a',path:'n.md',hash:h1,parents:[]},{id:'b',path:'n.md',hash:h2,parents:[]}];
 const conflictHash=[h1,h2].sort()[1],a=local();a.conflictFiles.set(a.conflictPath('n.md',conflictHash),encode('user content'));
 a.writeConflict=async()=>{throw new Error('Conflict destination occupied: n.md');};
 await assert.rejects(engine(r,a).sync(),/destination occupied/);assert.equal(a.files.has('n.md'),false);
});
test('unchanged sync downloads no blobs and performs no local writes',async()=>{
 const r=remote(),a=local({'n.md':'safe'}),e=engine(r,a);await e.sync();let downloads=0,writes=0;const get=r.getBlob,write=a.writeIfUnchanged;r.getBlob=async function(h){downloads++;return get.call(this,h);};a.writeIfUnchanged=async function(...args){writes++;return write.apply(this,args);};await e.sync();assert.equal(downloads,0);assert.equal(writes,0);
});
test('unchanged fast path defers a local edit after the scan',async()=>{
 const r=remote(),a=local({'n.md':'safe'}),e=engine(r,a);await e.sync();const read=a.read;a.read=async function(p){this.files.set(p,encode('typing'));return read.call(this,p);};const result=await e.sync();assert.equal(a.text('n.md'),'typing');assert.ok(result.deferred.includes('n.md'));assert.equal(e.state.baseline['n.md'].hash,await hash(encode('safe')));
});
test('large first upload keeps only one newly planned file in the durable queue',async()=>{
 const r=remote(),a=local({'a.bin':'a','b.bin':'b','c.bin':'c'}),order=[];let largest=0;
 const read=a.read,put=r.putEvent;
 a.read=async function(path){order.push(`read:${path}`);return read.call(this,path);};
 r.putEvent=async function(event){order.push(`event:${event.path}`);return put.call(this,event);};
 await engine(r,a,undefined,async state=>{largest=Math.max(largest,state.outbox.length);}).sync();
 assert.equal(largest,1);
 assert.deepEqual(order,['read:a.bin','event:a.bin','read:b.bin','event:b.bin','read:c.bin','event:c.bin','read:a.bin','read:b.bin','read:c.bin']);
});
test('verification downloads every cloud blob and detects corruption',async()=>{
 const r=remote(),a=local({'note.md':'text','image.bin':'bytes'}),e=engine(r,a);await e.sync();
 const ok=await e.verify();assert.deepEqual(ok,{files:2,conflicts:0,blobs:2});
 const original=r.getBlob,first=[...r.blobs.keys()][0];
 r.getBlob=async function(value){return value===first?encode('corrupt'):original.call(this,value);};
 await assert.rejects(e.verify(),/integrity/);
});
