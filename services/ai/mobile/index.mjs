// Portable reference adapter for the APMS eleven-input ONNX tensor contract.
// Runtime construction is injected so this file has no native or ORT dependency.
import { bindAssessmentQueries, compileAssessmentContexts, validateAssessmentContextMetadata } from './assessment-context.mjs';
const INPUT_NAMES = ["values", "field_ids", "kinds", "schema_tokens", "history_mask", "query_ids", "query_mask", "legal_category_mask", "schema_mask", "numeric_bounds", "query_features"];
const KINDS = { float: 0, integer: 1, boolean: 2, category: 3 };
const MISSING = { float: 4, integer: 5, boolean: 6, category: 7 };
const REF = { componentId:"components", calculationRootComponentId:"components", gradingComponentId:"components", periodId:"periods", finalPeriodId:"periods", groupId:"groups", groupIds:"groups", parentGroupId:"groups", gradingGroupId:"groups", groupTypeId:"groupTypes", factorId:"factors" };
const IGNORED = new Set(["id","name","description","shortCode","color","recommendedAction","provider","modelName","modelVersion","officialRecordSystem","effectiveFrom","effectiveUntil","schemaVersion","definitionVersion","inputFeatures","outputFields","supportedScenarios","explanation"]);
const NAMESPACES = ["components","periods","groups","groupTypes","assessmentTypes","factors","levels"];
const DIVISORS = [8,4096,512,512,1,512,8,512,1,1,1,1,1,1,1,1];
const finite = (x, label) => { if (typeof x !== "number" || !Number.isFinite(x)) throw new TypeError(`${label} must be finite`); return x; };
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const tf = (ort, type, data, dims) => new ort.Tensor(type, data, dims);

function validateExample(ex, metadata) {
  if (!ex || !Array.isArray(ex.fields) || !Array.isArray(ex.history) || !Array.isArray(ex.queries)) throw new TypeError("Example requires fields, history, and queries arrays");
  const assessmentContextVersion=validateAssessmentContextMetadata(metadata);
  const cfg=metadata.model_config||{}, limits={fields:cfg.max_fields??512,history:cfg.max_history??512,queries:cfg.max_queries??128,categories:cfg.categories??16};
  if (ex.fields.length>limits.fields || ex.history.length>limits.history || !ex.queries.length || ex.queries.length>limits.queries) throw new RangeError("Example exceeds model sequence limits or has no output queries");
  const ids=new Map();
  ex.fields.forEach((f,i)=>{ if (!f || typeof f.name!=="string" || !f.name || !own(KINDS,f.kind) || ids.has(f.name)) throw new TypeError("Invalid or duplicate field specification");
    if (f.kind==="category" && (!Array.isArray(f.categories)||!f.categories.length||f.categories.some(x=>typeof x!=="string")||new Set(f.categories).size!==f.categories.length)) throw new TypeError(`Invalid category domain for ${f.name}`);
    for (const v of [f.minimum,f.maximum]) if (v!==undefined&&v!==null) finite(v,`bound for ${f.name}`);
    if(f.minimum!=null&&f.maximum!=null&&f.minimum>f.maximum) throw new RangeError(`Invalid bounds for ${f.name}`);
    if(f.kind==="integer"&&f.minimum!=null&&f.maximum!=null&&Math.ceil(f.minimum)>Math.floor(f.maximum))throw new RangeError(`Integer domain contains no legal integer for ${f.name}`); ids.set(f.name,i); });
  const specs=new Map(ex.fields.map(f=>[f.name,f]));
  for(const row of ex.history){if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).some(k=>!specs.has(k))) throw new TypeError("History contains undeclared fields");
    for(const [k,v] of Object.entries(row)) validateValue(specs.get(k),v,k);}
  for(const q of ex.queries){if(!q||typeof q!=="object"||!specs.has(q.field)) throw new TypeError("Each query must identify a declared field");
    if(own(q,"factor_ref")) throw new TypeError("Schema-bound factor queries must be resolved by the app domain validator before mobile inference");
    if(own(q,"assessment_ref")&&(typeof q.assessment_ref!=="string"||!q.assessment_ref)) throw new TypeError("Assessment query reference must be a nonempty opaque identifier");
    if(!Number.isInteger(q.horizon??1)||(q.horizon??1)<1||(q.horizon??1)>128) throw new RangeError("Query horizon must be an integer from 1 to 128");
    const s=specs.get(q.field); for(const v of [q.minimum??s.minimum,q.maximum??s.maximum]) if(v!=null) finite(v,"query bound");
    const lo=q.minimum??s.minimum, hi=q.maximum??s.maximum; if(lo!=null&&hi!=null&&lo>hi) throw new RangeError("Query bounds are inverted");
    if(s.minimum!=null&&lo!=null&&lo<s.minimum||s.maximum!=null&&hi!=null&&hi>s.maximum)throw new RangeError("Query bounds cannot widen the declared field domain");
    if(s.kind==="integer"&&lo!=null&&hi!=null&&Math.ceil(lo)>Math.floor(hi))throw new RangeError("Integer query domain contains no legal integer");
    if(q.choices!==undefined){if(!Array.isArray(q.choices)||!q.choices.length||q.choices.length>limits.categories||new Set(q.choices.map(x=>JSON.stringify(x))).size!==q.choices.length) throw new TypeError("Query choices must be unique and within model capacity"); for(const v of q.choices) validateValue(s,v,q.field);}
  }
  if(ex.schema && typeof ex.schema!=="object") throw new TypeError("Schema snapshots must be an object");
  if(assessmentContextVersion===1 && ex.queries.some(q=>own(q,"assessment_ref")) && !ex.schema?.gradingSystem) throw new TypeError("Assessment-bound queries require a grading schema snapshot");
  return {ids,specs,limits,assessmentContextVersion};
}
function validateValue(s,v,label){if(v===null)return; if(s.kind==="float"||s.kind==="integer"){if(typeof v!=="number"||!Number.isFinite(v)||s.kind==="integer"&&!Number.isInteger(v)) throw new TypeError(`Invalid ${s.kind} value for ${label}`); if(s.minimum!=null&&v<s.minimum||s.maximum!=null&&v>s.maximum) throw new RangeError(`Value outside bounds for ${label}`);} else if(s.kind==="boolean"&&typeof v!=="boolean") throw new TypeError(`Invalid boolean for ${label}`); else if(s.kind==="category"&&!s.categories.includes(v)) throw new TypeError(`Unknown category for ${label}`);}

function compileSchema(schema, symbolIds) {
  const tokens=[], entities={};
  for(const ns of NAMESPACES) entities[ns]=Object.fromEntries(((ns==="factors"||ns==="levels")?(schema.evaluationCriteria||{}):(schema.gradingSystem||{}) )[ns]?.map((x,i)=>[x.id,i])||[]);
  const factors=Object.fromEntries((schema.evaluationCriteria?.factors||[]).map(x=>[x.id,x]));
  const domains=Object.fromEntries(Object.entries(factors).map(([id,f])=>[id,[...(f.categories||[])]]));
  for(const level of schema.evaluationCriteria?.levels||[]) for(const r of level.rules||[]) if(domains[r.factorId]) {const vals=Array.isArray(r.threshold)?r.threshold:(typeof r.threshold==="string"&&["in","not_in"].includes(r.operator)?r.threshold.split(","):[r.threshold]); for(const v of vals) if(typeof v==="string"&&!domains[r.factorId].includes(v.trim()))domains[r.factorId].push(v.trim());}
  const emit=(kind,parent,key,index,scalar=0,symbol=0,namespace=0,reference=-1)=>{const numeric=Math.sign(scalar)*Math.log1p(Math.abs(scalar)); const v=[kind,parent,symbolIds[key]||0,index,numeric,symbol,namespace,reference,...Array(8).fill(0)]; tokens.push(v);return tokens.length-1;};
  const walk=(v,parent,key,index=-1,path=[],factorId=null)=>{
    if(IGNORED.has(key))return;
    if(v&&typeof v==="object"&&!Array.isArray(v)){const node=emit(1,parent,key,index);factorId=v.factorId??(key==="factors"?v.id:factorId); for(const k of Object.keys(v).sort())walk(v[k],node,k,-1,[...path,key],factorId);}
    else if(Array.isArray(v)){const node=emit(2,parent,key,index,v.length);v.forEach((x,i)=>walk(x,node,key,i,path,factorId));}
    else if(typeof v==="boolean")emit(4,parent,key,index,Number(v));
    else if(typeof v==="number")emit(3,parent,key,index,v);
    else if(v===null)emit(0,parent,key,index);
    else if(typeof v==="string"){
      let ns=REF[key]; if(key==="typeId")ns=path.includes("groups")?"groupTypes":"assessmentTypes";
      if(ns){if(!own(entities[ns],v))throw new TypeError(`Unknown ${ns} reference`);emit(6,parent,key,index,0,0,NAMESPACES.indexOf(ns)+1,entities[ns][v]);}
      else if(key==="categories"||key==="letter"||(key==="value"&&path.includes("mapping"))){let pos=index;if(pos<0&&parent>=0)pos=tokens[parent][3];emit(7,parent,key,index,0,0,0,pos);}
      else if(key==="threshold"&&factorId&&domains[factorId]&&(["recent_trend","ai_risk_level","trend","data_basis"].includes(factors[factorId].source)||factors[factorId].valueType==="category")){for(const [i,c] of v.split(",").entries()){const ref=domains[factorId].indexOf(c.trim());if(ref<0)throw new TypeError("Unknown category threshold");emit(7,parent,key,i,0,0,0,ref);}}
      else if(own(symbolIds,v))emit(5,parent,key,index,0,symbolIds[v]); else throw new TypeError(`Unsupported symbolic schema attribute: ${key}`);
    } else throw new TypeError("Unsupported schema value");
  };
  if(schema.gradingSystem)walk(schema.gradingSystem,-1,"gradingSystem"); if(schema.evaluationCriteria)walk(schema.evaluationCriteria,-1,"evaluationCriteria");
  if(!tokens.length)tokens.push(Array(16).fill(0)); return tokens.map(row=>row.map((x,i)=>x/DIVISORS[i]));
}

export function prepareExample(ex, metadata, ort) {
  ex=bindAssessmentQueries(ex);
  const {ids,specs,limits,assessmentContextVersion}=validateExample(ex,metadata), fields=metadata.fields;
  if(!Array.isArray(fields)||ex.fields.some(f=>!fields.includes(f.name))) throw new TypeError("Example fields must be a subset of trained manifest fields");
  const maxCats=limits.categories, prep=metadata.preprocessing||{}, history=[];
  for(const row of ex.history) for(const name of fields) if(own(row,name)) {const s=specs.get(name),v=row[name];let value=0,kind;
    if(v===null)kind=MISSING[s.kind]; else if(s.kind==="float"||s.kind==="integer"){const [c=0,scale=1]=prep[name]||[0,1];value=(v-c)/Math.max(scale,1e-6);kind=KINDS[s.kind];}
    else if(s.kind==="boolean"){value=Number(v);kind=2;} else {value=s.categories.indexOf(v)+1;kind=3;}
    if(!Number.isFinite(value))throw new TypeError("Non-finite encoded history value"); history.push([value,fields.indexOf(name),kind]); }
  if(!history.length)history.push([0,0,4]); if(history.length>limits.history)throw new RangeError("History token limit exceeded");
  const schema=compileSchema(ex.schema||{},metadata.schema_symbols||{}), H=history.length,Q=ex.queries.length,S=schema.length;
  const assessmentContexts=assessmentContextVersion===1?compileAssessmentContexts(ex):ex.queries.map(()=>Array(34).fill(0));
  if(S>(metadata.maximum_schema_tokens??4096))throw new RangeError("Applied schema exceeds configured context token limit");
  const values=new Float32Array(H),fieldIds=new BigInt64Array(H),kinds=new BigInt64Array(H); history.forEach(([v,f,k],i)=>{values[i]=v;fieldIds[i]=BigInt(f);kinds[i]=BigInt(k);});
  const schemaTokens=new Float32Array(S*16);schema.forEach((r,i)=>r.forEach((x,j)=>schemaTokens[i*16+j]=x));
  const queryFeatureWidth=assessmentContextVersion===1?42:8;
  const queryIds=new BigInt64Array(Q),legal=new Uint8Array(Q*maxCats),bounds=new Float32Array(Q*2),features=new Float32Array(Q*queryFeatureWidth);bounds.fill(Infinity);for(let i=0;i<Q;i++)bounds[i*2]=-Infinity;
  ex.queries.forEach((q,j)=>{const s=specs.get(q.field),kind=q.choices?.length?"mapped":s.kind,[center=0,scale0=1]=prep[q.field]||[0,1],scale=Math.max(scale0,1e-6),lo=q.minimum??s.minimum,hi=q.maximum??s.maximum; queryIds[j]=BigInt(fields.indexOf(q.field));
    if(["float","integer","mapped"].includes(kind)){if(lo!=null)bounds[j*2]=(lo-center)/scale;if(hi!=null)bounds[j*2+1]=(hi-center)/scale;}
    const f=j*queryFeatureWidth;features[f]=Math.min(1,Math.log1p(q.horizon??1)/Math.log(129));features[f+1]=({float:0,integer:1,boolean:2,category:3,mapped:4})[kind];features[f+2]=Number(lo!=null);features[f+3]=Number(hi!=null);
    if(lo!=null)features[f+4]=Math.max(-10,Math.min(10,(lo-center)/scale))/10;if(hi!=null)features[f+5]=Math.max(-10,Math.min(10,(hi-center)/scale))/10;
    const choices=q.choices||(kind==="category"?s.categories:kind==="boolean"?[false,true]:[]); if(choices.length>maxCats)throw new RangeError("Output query exceeds configured category limit");choices.forEach((_,i)=>legal[j*maxCats+i]=1);features[f+6]=choices.length/maxCats;features[f+7]=Number(Boolean(ex.schema?.gradingSystem||ex.schema?.evaluationCriteria));
    if(assessmentContextVersion===1){const context=assessmentContexts[j];if(context.length!==34||context.some(x=>!Number.isFinite(x)))throw new TypeError("Assessment context compiler returned an invalid feature vector");context.forEach((value,index)=>{features[f+8+index]=value;});}
  });
  const tensor=(type,data,dims)=>tf(ort,type,data,dims);
  const feed={values:tensor("float32",values,[1,H]),field_ids:tensor("int64",fieldIds,[1,H]),kinds:tensor("int64",kinds,[1,H]),schema_tokens:tensor("float32",schemaTokens,[1,S,16]),history_mask:tensor("bool",new Uint8Array(H),[1,H]),query_ids:tensor("int64",queryIds,[1,Q]),query_mask:tensor("bool",Uint8Array.from({length:Q},(_,i)=>Number(i>=ex.queries.length)),[1,Q]),legal_category_mask:tensor("bool",legal,[1,Q,maxCats]),schema_mask:tensor("bool",new Uint8Array(S),[1,S]),numeric_bounds:tensor("float32",bounds,[1,Q,1,2]),query_features:tensor("float32",features,[1,Q,queryFeatureWidth])};
  return {feed,fields,specs,queryCount:ex.queries.length,maxCats,example:ex};
}

function softmax(a){const m=Math.max(...a),e=a.map(x=>Math.exp(x-m)),z=e.reduce((x,y)=>x+y,0);return e.map(x=>x/z);}
function correctBoundRoundoff(value, minimum, maximum) {
  // Match Python's float32 boundary tolerance; larger violations still reject.
  const tolerance=2e-5*Math.max(1,Math.abs(minimum??0),Math.abs(maximum??0));
  if(minimum!=null&&minimum-tolerance<=value&&value<minimum)return minimum;
  if(maximum!=null&&maximum<value&&value<=maximum+tolerance)return maximum;
  return value;
}
function roundTiesToEven(value) {
  // Math.round uses a different tie rule from Python round, including negatives.
  const lower=Math.floor(value), fraction=value-lower;
  if(fraction<0.5)return lower;
  if(fraction>0.5)return lower+1;
  return lower%2===0?lower:lower+1;
}
export function decodeOutputs(raw, ex, metadata, prepared) {
  ex=prepared.example||ex;
  const {specs,maxCats}=prepared, qs=ex.queries, calibration=metadata.calibration||{}, predictions=[];
  const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
  const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
  const tensorData=(t,dims,name)=>{
    if(Array.isArray(t)) return t;
    if(!t||!ArrayBuffer.isView(t.data)||!Array.isArray(t.dims)) throw new TypeError(`Model output ${name} must be an ONNX tensor or nested array`);
    if(t.dims.length!==dims.length||dims.some((d,i)=>d!==null&&t.dims[i]!==d))throw new TypeError(`Model output ${name} has invalid dimensions`);
    const flat=Array.from(t.data,Number);if(flat.some(x=>!Number.isFinite(x)))throw new TypeError(`Model output ${name} contains non-finite values`);
    let cursor=0;const nest=(axis)=>axis===t.dims.length?flat[cursor++]:Array.from({length:t.dims[axis]},()=>nest(axis+1));return nest(0);
  };
  raw={...raw,quantiles:tensorData(raw.quantiles,[1,qs.length,1,null],"quantiles"),categorical:tensorData(raw.categorical,[1,qs.length,null],"categorical"),trend:tensorData(raw.trend,[1,qs.length,3],"trend"),failure:tensorData(raw.failure,[1,qs.length],"failure")};
  for(let j=0;j<qs.length;j++){const q=qs[j],s=specs.get(q.field), kind=q.choices?.length?"mapped":s.kind, quant=Array.from(raw.quantiles?.[0]?.[j]?.[0]||[]), logits=Array.from(raw.categorical?.[0]?.[j]||[]), trend=Array.from(raw.trend?.[0]?.[j]||[]), failure=Number(raw.failure?.[0]?.[j]); if(!Number.isFinite(failure)||!trend.length||!quant.length||!logits.length)throw new TypeError("Model returned malformed output");
    if([...quant,...logits,...trend].some(x=>!Number.isFinite(x)))throw new TypeError("Model returned non-finite output values");
    const choices=q.choices||(kind==="category"?s.categories:kind==="boolean"?[false,true]:[]);let value,interval=null,classProbability=null;
    if(choices.length){const probs=softmax(logits.slice(0,choices.length));const best=probs.indexOf(Math.max(...probs));value=choices[best];classProbability=probs[best];}
    else {const [center=0,scale=1]=metadata.preprocessing?.[q.field]||[0,1], mid=quant[Math.floor(quant.length/2)];const domain={kind:s.kind,minimum:q.minimum??s.minimum??null,maximum:q.maximum??s.maximum??null,categories:s.categories||[],choices:q.choices||[]};value=correctBoundRoundoff(mid*scale+center,domain.minimum,domain.maximum);if(domain.minimum!=null&&value<domain.minimum||domain.maximum!=null&&value>domain.maximum)throw new RangeError("Prediction outside active schema bounds");if(kind==="integer"){if(domain.minimum!=null&&domain.maximum!=null&&Math.ceil(domain.minimum)>Math.floor(domain.maximum))throw new RangeError("Integer domain contains no legal integer");value=roundTiesToEven(value);if(domain.minimum!=null)value=Math.max(Math.ceil(domain.minimum),value);if(domain.maximum!=null)value=Math.min(Math.floor(domain.maximum),value);}const h=q.horizon??1;const cal=Object.values(calibration.by_query||{}).find(x=>x.field===q.field&&x.horizon===h&&same(x.domain,domain));if(quant.length>=2){let lo=quant[0]*scale+center-(cal?.radius??0),hi=quant.at(-1)*scale+center+(cal?.radius??0);if(kind==="integer"){lo=Math.floor(lo);hi=Math.ceil(hi);}if(domain.minimum!=null)lo=Math.max(kind==="integer"?Math.ceil(domain.minimum):domain.minimum,lo);if(domain.maximum!=null)hi=Math.min(kind==="integer"?Math.floor(domain.maximum):domain.maximum,hi);if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo>hi)throw new RangeError("Invalid numeric interval");interval={lower:lo,upper:hi,calibrated:cal?.radius!=null,nominal_coverage:cal?.radius!=null?(calibration.coverage_target??0.8):0.8};}}
    const lo=q.minimum??s.minimum,hi=q.maximum??s.maximum;if(typeof value==="number"&&(!Number.isFinite(value)||lo!=null&&value<lo||hi!=null&&value>hi))throw new RangeError("Prediction outside active schema bounds");
    const domain={kind:s.kind,minimum:q.minimum??s.minimum??null,maximum:q.maximum??s.maximum??null,categories:s.categories||[],choices:q.choices||[]};const h=q.horizon??1;const riskEntries=calibration.risk_by_query||{};const fcal=Object.values(riskEntries).find(x=>x.field===q.field&&x.horizon===h&&same(x.domain,domain))||(()=>{const matchingKey=Object.entries(calibration.by_query||{}).find(([,x])=>x.field===q.field&&x.horizon===h&&same(x.domain,domain))?.[0];return matchingKey?riskEntries[matchingKey]:null;})();const temp=fcal?.temperature??1;if(!Number.isFinite(temp)||temp<=0)throw new TypeError("Invalid failure calibration temperature");const probability=1/(1+Math.exp(-Math.max(-80,Math.min(80,failure/temp))));
    predictions.push({field:q.field,horizon:h,value,interval,trend:["improving","stable","declining"][trend.indexOf(Math.max(...trend))],failure_probability:probability,failure_calibrated:fcal?.calibrated??false,class_probability:classProbability,class_probability_calibrated:false});
  } return predictions;
}

/** Run one typed Example. Supply an ONNX Runtime API object and loaded session. */
export async function predictExample({ort,session,metadata,example,validateSchemas}) {
  if(!ort?.Tensor||!session?.run)throw new TypeError("Pass the ONNX Runtime API and a loaded session");
  if((example.schema?.gradingSystem||example.schema?.evaluationCriteria)&&typeof validateSchemas!=="function")throw new TypeError("Applied schema snapshots require the app's full domain schema and semantic validator");
  if(validateSchemas)await validateSchemas(example.schema||{});
  const prepared=prepareExample(example,metadata,ort), raw=await session.run(prepared.feed);
  return decodeOutputs(raw,prepared.example||example,metadata,prepared);
}

export const inputNames=INPUT_NAMES;
