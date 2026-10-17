#!/usr/bin/env node
// Cross-language feed helper: node conformance.mjs [prepare|decode] < request.json
import { prepareExample, decodeOutputs } from './index.mjs';

class Tensor { constructor(type,data,dims){Object.assign(this,{type,data,dims});} }
const input=JSON.parse(await new Promise((resolve,reject)=>{
  let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>resolve(data));process.stdin.on('error',reject);
}));
const [command='prepare']=process.argv.slice(2);
const prepared=prepareExample(input.example,input.metadata,{Tensor});
const feed=Object.fromEntries(Object.entries(prepared.feed).map(([name,t])=>[name,{type:t.type,dims:t.dims,data:Array.from(t.data,x=>typeof x==='bigint'?x.toString():Number.isFinite(x)?x:String(x))}]));
if(command==='prepare')process.stdout.write(JSON.stringify({feed},null,2)+'\n');
else if(command==='decode'){
  if(!input.outputs||!input.outputs.quantiles||!input.outputs.categorical||!input.outputs.trend||!input.outputs.failure)throw new TypeError('decode requires outputs with quantiles, categorical, trend, and failure arrays');
  const outputs=Object.fromEntries(Object.entries(input.outputs).map(([k,v])=>[k,[v]]));
  process.stdout.write(JSON.stringify({predictions:decodeOutputs(outputs,input.example,input.metadata,prepared)},null,2)+'\n');
} else throw new TypeError('Command must be prepare or decode');
