'use strict';
const {spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const run=args=>{const r=spawnSync(process.execPath,args,{cwd:__dirname,stdio:'inherit'});if(r.status!==0)process.exit(r.status||1)};
run(['build.cjs']);run(['--check','dist/main.js']);
run(['--test','--test-reporter=tap',...fs.readdirSync(path.join(__dirname,'test')).filter(f=>/\.test\.(cjs|mjs)$/.test(f)).map(f=>'test/'+f)]);
for(const file of fs.readdirSync(path.join(__dirname,'regression')).filter(f=>f.endsWith('.cjs')).sort())run(['regression/'+file]);
console.log('All available Node regression suites passed. Browser/native/device checks are separate and are not implied.');
