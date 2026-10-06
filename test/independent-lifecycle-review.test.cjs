'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const clock={text:'10:00:00'};const local=new Map(),secret=new Map(),events=[],commands=[],opened=[],notices=[],buttons=[];const document={visibilityState:'visible'},navigator={onLine:true},window={setInterval:()=>1};
 class Plugin{addRibbonIcon(){} addStatusBarItem(){return {setText(){},addClass(){},addEventListener(){}}} addCommand(c){commands.push(c)}addSettingTab(){}registerInterval(){}registerObsidianProtocolHandler(){}registerDomEvent(target,name,fn){events.push({target,name,fn})}}
 class Fuzzy{constructor(app){this.app=app}open(){opened.push(this)}}
 const element=()=>({style:{},empty(){},addClass(){},setText(){},createEl:()=>element(),createDiv:()=>element()});
 class Modal{constructor(){this.contentEl=element()}open(){this.onOpen?.()}}
 class Setting{setName(){return this}setDesc(){return this}addButton(fn){const b={setButtonText(text){this.text=text;return this},setCta(){return this},setDisabled(){return this},onClick(cb){this.click=cb;return this}};fn(b);buttons.push(b);return this}}

 const context={Date:class extends Date{toLocaleTimeString(){return clock.text}},module:{exports:{}},require:id=>{assert.equal(id,'obsidian');return {Plugin,FuzzySuggestModal:Fuzzy,Modal,PluginSettingTab:class{},Setting,Platform:{isMobile:true},Notice:class{constructor(message){notices.push(message)}},requestUrl:()=>{throw Error('NETWORK FORBIDDEN')}}},crypto:globalThis.crypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,URL,URLSearchParams,btoa,document,navigator,window};
 vm.runInNewContext(fs.readFileSync(__dirname+'/../dist/main.js','utf8').replace('module.exports = EasySync;', 'EasySync.__testModal = ConnectModal; module.exports = EasySync;'),context);
 const p=new context.module.exports(),folders=[{path:'',children:[]},{path:'Team',children:[]},{path:'Private',children:[]},{path:'.obsidian',children:[]},{path:'Team/note.md'}];
 p.app={loadLocalStorage:k=>local.get(k),saveLocalStorage:(k,v)=>local.set(k,v),secretStorage:{getSecret:k=>secret.get(k),setSecret:(k,v)=>secret.set(k,v)},workspace:{onLayoutReady:fn=>fn()},vault:{getAllLoadedFiles:()=>folders,getRoot:()=>folders[0],getAbstractFileByPath:pth=>folders.find(f=>f.path===pth)}};
 return {p,clock,document,navigator,window,events,commands,opened,local,notices,buttons};
}
test('review: simultaneous mobile triggers use one active engine and unload blocks new work',async()=>{
 const f=fixture();await f.p.onload();f.p.connection={kind:'personal',id:'personal_project'};let complete,calls=0;
 f.p.engine={sync:()=>{calls++;return new Promise(r=>{complete=r})},remote:{}};
 const vis=f.events.find(e=>e.name==='visibilitychange'),online=f.events.find(e=>e.name==='online');
 const running=f.p.sync(false);vis.fn();online.fn();vis.fn();assert.equal(calls,1);assert.equal(f.p.running,true);
 f.p.onunload();vis.fn();online.fn();assert.equal(calls,1);complete({conflicts:[],deferred:[]});await running;assert.equal(f.p.running,false);
});
test('review: reloaded instance cannot overlap still-finishing unloaded instance',async()=>{
 const f=fixture();await f.p.onload();f.p.connection={kind:'personal',id:'personal_project'};let complete;f.p.engine={sync:()=>new Promise(r=>{complete=r}),remote:{}};
 const running=f.p.sync(false);f.p.onunload();const second=new f.p.constructor();second.app=f.p.app;await second.onload();second.connection=f.p.connection;let secondCalls=0;second.engine={sync:async()=>{secondCalls++;return {conflicts:[],deferred:[]}},remote:{}};
 await second.sync(false);assert.equal(secondCalls,0);complete({conflicts:[],deferred:[]});await running;await second.sync(false);assert.equal(secondCalls,1);
});
test('review: persistent conflict notices deduplicate despite displayed timestamp',async()=>{
 const f=fixture();await f.p.onload();f.p.connection={kind:'personal',id:'personal_project'};f.p.engine={sync:async()=>({conflicts:['a.md'],deferred:[]}),remote:{}};
 await f.p.sync(false);f.clock.text='10:01:00';await f.p.sync(false);assert.equal(f.notices.length,1);
});
test('review: late auto failure after unload does not show a new notice',async()=>{
 const f=fixture();await f.p.onload();f.p.connection={kind:'personal',id:'personal_project'};let reject;f.p.engine={sync:()=>new Promise((_,r)=>{reject=r}),remote:{}};const running=f.p.sync(false);f.p.onunload();reject(Error('late failure'));await running;assert.equal(f.notices.length,0);
});
