'use strict';
// Dependency-free bundler; module wrapper matches the authentic installed artifact.
const fs=require('node:fs'),path=require('node:path');
const files=fs.readdirSync(path.join(__dirname,'src')).filter(f=>f.endsWith('.cjs')).sort();
const modules=files.map(file=>{
 const source=fs.readFileSync(path.join(__dirname,'src',file),'utf8').replace(/require\('\.\/([^']+)'\)/g,(_,name)=>`load(${JSON.stringify(name)})`);
 return `${JSON.stringify(file)}: function(module, exports, load) {\n${source}\n}`;
});
const bundle=`'use strict';\nconst modules = {\n${modules.join(',\n')}\n};\nconst cache = Object.create(null);\nfunction load(id) { if (cache[id]) return cache[id].exports; if (!modules[id]) throw new Error('Unknown module'); const m = {exports:{}}; cache[id]=m; modules[id](m,m.exports,load); return m.exports; }\nmodule.exports=load('main.cjs');\n`;
fs.mkdirSync(path.join(__dirname,'dist'),{recursive:true});fs.writeFileSync(path.join(__dirname,'dist/main.js'),bundle);
console.log(require('node:crypto').createHash('sha256').update(bundle).digest('hex'));

for(const file of ['manifest.json','styles.css'])fs.copyFileSync(path.join(__dirname,file),path.join(__dirname,'dist',file));
