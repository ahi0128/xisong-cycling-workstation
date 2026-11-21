import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const paths=['index.html','app.js','data.js','style.css','ledger.html','ledger.js','coach-plan.html','parent-dues.html'];
const assets=Object.fromEntries(paths.map(name=>['/'+name,readFileSync('public/'+name,'utf8')]));
mkdirSync('dist/server',{recursive:true});
writeFileSync('dist/server/index.js','const assets = '+JSON.stringify(assets)+';\n'+readFileSync('worker/index.js','utf8'));
