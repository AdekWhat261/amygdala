'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const local=new Map(),secret=new Map(),events=[],commands=[],opened=[],notices=[],buttons=[];const document={visibilityState:'visible'},navigator={onLine:true},window={setInterval:()=>1};
 class Plugin{addRibbonIcon(){} addStatusBarItem(){return {setText(){},addClass(){},addEventListener(){}}} addCommand(c){commands.push(c)}addSettingTab(){}registerInterval(){}registerObsidianProtocolHandler(){}registerDomEvent(target,name,fn){events.push({target,name,fn})}}
 class Fuzzy{constructor(app){this.app=app}open(){opened.push(this)}}
 const element=()=>({style:{},empty(){},addClass(){},setText(){},createEl:()=>element(),createDiv:()=>element()});
 class Modal{constructor(){this.contentEl=element()}open(){this.onOpen?.()}}
 class Setting{setName(){return this}setDesc(){return this}addButton(fn){const b={setButtonText(text){this.text=text;return this},setCta(){return this},setDisabled(){return this},onClick(cb){this.click=cb;return this}};fn(b);buttons.push(b);return this}}

 const context={module:{exports:{}},require:id=>{assert.equal(id,'obsidian');return {Plugin,FuzzySuggestModal:Fuzzy,Modal,PluginSettingTab:class{},Setting,Platform:{isMobile:true},Notice:class{constructor(message){notices.push(message)}},requestUrl:()=>{throw Error('NETWORK FORBIDDEN')}}},crypto:globalThis.crypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,URL,URLSearchParams,btoa,document,navigator,window};
 vm.runInNewContext(fs.readFileSync(__dirname+'/../dist/main.js','utf8').replace('module.exports = EasySync;', 'EasySync.__testModal = ConnectModal; module.exports = EasySync;'),context);
 const p=new context.module.exports(),folders=[{path:'',children:[]},{path:'Team',children:[]},{path:'Private',children:[]},{path:'.obsidian',children:[]},{path:'Team/note.md'}];
 p.app={loadLocalStorage:k=>local.get(k),saveLocalStorage:(k,v)=>local.set(k,v),secretStorage:{getSecret:k=>secret.get(k),setSecret:(k,v)=>secret.set(k,v)},workspace:{onLayoutReady:fn=>fn()},vault:{getAllLoadedFiles:()=>folders,getRoot:()=>folders[0],getAbstractFileByPath:pth=>folders.find(f=>f.path===pth)}};
 return {p,document,navigator,window,events,commands,opened,local,notices,buttons};
}
test('foreground/online resumption respects auto, visibility, offline, and unload',async()=>{
 const f=fixture();f.local.set('amygdala-connection-preferences',{auto:true});await f.p.onload();let syncs=0;f.p.sync=async()=>{syncs++};f.p.connection={kind:'team',id:'project_id'};
 const vis=f.events.find(e=>e.name==='visibilitychange'),online=f.events.find(e=>e.name==='online');assert(vis&&online);
 f.document.visibilityState='hidden';vis.fn();online.fn();assert.equal(syncs,0);
 f.document.visibilityState='visible';vis.fn();assert.equal(syncs,1);
 f.navigator.onLine=false;vis.fn();assert.equal(syncs,1);f.navigator.onLine=true;online.fn();assert.equal(syncs,2);
 f.p.prefs.auto=false;vis.fn();assert.equal(syncs,2);f.p.prefs.auto=true;f.p.onunload();vis.fn();assert.equal(syncs,2);
});
test('touch-select folder picker excludes root for team and persists selection without keyboard',async()=>{
 const f=fixture();await f.p.onload();f.p.connection={kind:'team',id:'project_id'};f.p.chooseTeamScopeFolder();const picker=f.opened.at(-1);
 assert.deepEqual(Array.from(picker.getItems(),x=>x.path),['Private','Team']);picker.onChooseItem(picker.getItems().find(x=>x.path==='Team'));await Promise.resolve();
 assert.equal(f.local.get('amygdala-team-scope-project_id'),'Team');assert.equal(f.p.teamScopePath(),'Team');
 const second=fixture();second.local.set('amygdala-team-scope-project_id','Team');second.p.connection={kind:'team',id:'project_id'};assert.equal(second.p.teamScopePath(),'Team');
});
test('default folder picker includes vault root; native core new-note command not replaced',async()=>{
 const f=fixture();await f.p.onload();let chosen;f.p.applyDefaultNoteFolder=p=>{chosen=p};f.p.chooseDefaultNoteFolder();const picker=f.opened.at(-1);assert.equal(picker.getItemText(picker.getItems()[0]),'Vault root');picker.onChooseItem({path:'Team'});assert.equal(chosen,'Team');assert(!f.commands.some(c=>['new-note','new-file'].includes(c.id)));
});

test('mobile foreground sync failures are visible once, reset after recovery',async()=>{
 const f=fixture();await f.p.onload();f.p.connection={kind:'personal',id:'personal_project'};
 const fail=()=>{f.p.engine={sync:async()=>{throw Error('Offline test failure')},remote:{}}};
 fail();await f.p.sync(false);fail();await f.p.sync(false);assert.equal(f.notices.length,1);assert.match(f.notices[0],/Offline test failure/);
 f.p.engine={sync:async()=>({conflicts:[],deferred:[]}),remote:{}};await f.p.sync(false);fail();await f.p.sync(false);assert.equal(f.notices.length,2);
 f.document.visibilityState='hidden';f.p.engine={sync:async()=>{throw Error('Different failure')},remote:{}};await f.p.sync(false);assert.equal(f.notices.length,2);
});
test('connected v4 reconnect button uses v4 authentication route',async()=>{
 const f=fixture();await f.p.onload();f.p.connection={kind:'team',version:4,id:'root_project',folderId:'team_folder',actor:{actorName:'Test'}};
 const modal=new f.p.constructor.__testModal(f.p);let mode;modal.beginLogin=async value=>{mode=value};await modal.render();const reconnect=f.buttons.find(b=>b.text==='Переподключить');assert(reconnect);reconnect.click();assert.equal(mode,'team-v4');
});
