import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { checkOutputIntegrity } from '../src/lib/agent/output-integrity.ts';
const base=process.env.BASE||'http://127.0.0.1:3015';
const stage=process.env.VERIFY_STAGE||'teaching-final';assert.match(stage,/^[a-z0-9-]+$/);const out=`docs/evidence/personal-system-2026-11-17/${stage}`;await fs.mkdir(out,{recursive:true});
const auth=JSON.parse(await fs.readFile('C:/Users/haozhe/AppData/Local/Temp/mentora-learning-qa/auth.json','utf8'));
const cookie=/mentora_session=([^;]+)/.exec(auth.cookie)[0];
const health=await(await fetch(base+'/api/health')).json();
const question='请详细讲清楚 C 的 realloc 为什么先用临时指针接收。已有 3 个 int，值是 10、20、30，现在想扩成 5 个。请用同一组数据逐步说明成功和失败后指针、内容分别怎样，给出安全的完整示例，最后只给一个针对性的自测。不要替我建学习计划。';
const response=await fetch(base+'/api/chat',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({task:'agent',args:{deep:true,noTools:true,requestQuestion:question,ctx:'隔离教学质量验收：用户已学过 malloc，正在学习动态数组。'},messages:[{role:'user',content:question}],temperature:0.5}),signal:AbortSignal.timeout(210000)});
assert.equal(response.status,200);
let answer='',buffer='',ended=false,usage=null;const reader=response.body.getReader(),decoder=new TextDecoder();
for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop()||'';for(const line of lines){if(!line.trim())continue;const event=JSON.parse(line);if(event.t==='d')answer+=event.v;if(event.t==='end')ended=true;if(event.t==='u')usage=event.v;if(event.t==='e')throw Error(event.v);}}
assert.ok(ended);const integrity=checkOutputIntegrity(answer);
await fs.writeFile(out+'/teaching.md',answer);
await fs.writeFile(out+'/results.json',JSON.stringify({base,build:health.build,question,requests:1,usage:usage??'unknown',chars:answer.length,integrity,manualQualityReview:'待逐项检查；长度与完整性检查不代表事实质量已通过。'},null,2));
assert.ok(answer.length>=800);assert.ok(integrity.ok,JSON.stringify(integrity));
console.log(JSON.stringify({build:health.build,requests:1,chars:answer.length,integrity,usage:usage??'unknown'}));
