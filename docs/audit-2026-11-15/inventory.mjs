import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.cwd();
const out = path.join(root, 'docs/audit-2026-11-15');
const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
    if (['node_modules','.next','.git','vendor','coverage'].includes(e.name)) continue;
    const p = path.join(dir,e.name);
    if(e.isDirectory()) walk(p);
    else if(/\.(?:[cm]?js|tsx?|css|wxml|wxss|ya?ml|sh|ps1)$/.test(e.name)) files.push(p);
  }
}
for(const dir of ['src','scripts','miniprogram','deploy']) walk(path.join(root,dir));
for(const e of fs.readdirSync(root)) if(/\.(?:[cm]?js|tsx?)$/.test(e)) files.push(path.join(root,e));
function shard(p) {
  const a=p.split('/');
  if(p.includes('/__tests__/') || /\.test\./.test(p)) return 'tests';
  if(a[0]==='src' && a[1]==='app') return a[2]==='api' ? `api/${a[3]}` : 'web/pages';
  if(a[0]==='src' && a[1]==='components') return 'web/components';
  if(a[0]==='src' && a[1]==='lib') return ['agent','server','ai'].includes(a[2]) ? `lib/${a[2]}` : 'lib/core';
  return a[0]==='src' ? 'web/other' : a.length===1 ? 'config' : a[0];
}
const signals = {
  correctness: /\b(?:catch|finally|Promise\.all|JSON\.parse)\b/g,
  maintainability: /(?:TODO|FIXME|eslint-disable|@ts-ignore)/g,
  security: /(?:dangerouslySetInnerHTML|verifySession|requireAdmin|eval\(|new Function|exec\(|spawn\()/g,
  performance: /(?:\.filter\(|\.find\(|\.map\(|\.sort\()/g,
  architecture: /(?:from\s+["']|require\()/g,
  uiConsistency: /(?:text-\[|z-\[|fixed |sticky |#[0-9a-fA-F]{6})/g,
  debugTypes: /(?:console\.(?:log|debug)|\bas any\b|@ts-|__mentora|debugger)/g,
  uiStates: /(?:loading|pending|busy|error|Empty|Skeleton|\.ok\b)/g,
  costAvailability: /(?:while\s*\(|setInterval\(|fetch\(|\.read\(|retry|dbGet|dbSet|chat\()/g,
};
const inventory = files.sort().map(p=>{
  const content=fs.readFileSync(p,'utf8'), relative=path.relative(root,p).replaceAll('\\','/');
  return {path:relative,shard:shard(relative),lines:content.split(/\r?\n/).length,sha256:crypto.createHash('sha256').update(content).digest('hex'),signals:Object.fromEntries(Object.entries(signals).map(([k,re])=>[k,[...content.matchAll(re)].length]))};
});
const shards={};
for(const f of inventory){ const s=shards[f.shard]??={files:0,lines:0,signals:{}};s.files++;s.lines+=f.lines;for(const [k,n] of Object.entries(f.signals))s.signals[k]=(s.signals[k]||0)+n; }
fs.writeFileSync(path.join(out,'inventory.json'),JSON.stringify({generatedAt:new Date().toISOString(),files:inventory,shards},null,2));
fs.writeFileSync(path.join(out,'source-files.txt'),inventory.map(f=>f.path).join('\n')+'\n');
const lint=JSON.parse(fs.readFileSync(path.join(out,'eslint.json'),'utf8'));
const diagnostics=lint.flatMap(f=>f.messages.map(m=>({file:path.relative(root,f.filePath).replaceAll('\\','/'),line:m.line,severity:m.severity,rule:m.ruleId,message:m.message})));
fs.writeFileSync(path.join(out,'eslint-diagnostics.json'),JSON.stringify(diagnostics,null,2));
console.log(JSON.stringify({files:inventory.length,lines:inventory.reduce((s,f)=>s+f.lines,0),shards:Object.fromEntries(Object.entries(shards).map(([k,v])=>[k,{files:v.files,lines:v.lines}])),eslint:{files:lint.length,errors:diagnostics.filter(x=>x.severity===2).length,warnings:diagnostics.filter(x=>x.severity===1).length}},null,2));
