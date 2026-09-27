'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const files = fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.cjs'));
const modules = files.map(file => {
  let source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
  source = source.replace(/require\('\.\/([^']+)'\)/g, (_, name) => `load(${JSON.stringify(name)})`)
    .replace("require('../config.json')", `(${fs.readFileSync(path.join(root, 'config.json'), 'utf8')})`);
  return `${JSON.stringify(file)}: function(module, exports, load) {\n${source}\n}`;
});
const bundle = `'use strict';\nconst modules = {\n${modules.join(',\n')}\n};\nconst cache = Object.create(null);\nfunction load(id) { if (cache[id]) return cache[id].exports; if (!modules[id]) throw new Error('Unknown module'); const m = {exports:{}}; cache[id]=m; modules[id](m,m.exports,load); return m.exports; }\nmodule.exports=load('main.cjs');\n`