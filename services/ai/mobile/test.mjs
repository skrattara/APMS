import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareExample, inputNames, decodeOutputs } from './index.mjs';
import { ASSESSMENT_CONTEXT_FEATURE_NAMES, ASSESSMENT_CONTEXT_NORMALIZATION_VERSION, ASSESSMENT_RESULT_CUTOFF } from './assessment-context.mjs';

class Tensor { constructor(type,data,dims){Object.assign(this,{type,data,dims});} }
const ort={Tensor};
const metadata={fields:['score','state'],model_config:{max_history:512,max_queries:128,categories:16},preprocessing:{score:[50,10]},schema_symbols:{gradingSystem:1,evaluationCriteria:2,components:3,calculation:4,mode:5,linear:6}};
const example={fields:[{name:'score',kind:'float',minimum:0,maximum:100},{name:'state',kind:'category',categories:['ready','late']}],history:[{score:60,state:'late'},{score:null,state:'ready'}],queries:[{field:'score',horizon:2},{field:'state',horizon:1}],schema:{gradingSystem:{components:[{calculation:{mode:'linear'}}]}}};
const prepared=prepareExample(example,metadata,ort), f=prepared.feed;
assert.deepEqual(Object.keys(f),inputNames);
assert.deepEqual(Array.from(f.values.data),[1,2,0,1]);
assert.deepEqual(Array.from(f.field_ids.data),[0n,1n,0n,1n]);
assert.deepEqual(Array.from(f.kinds.data),[0n,3n,4n,3n]);
assert.deepEqual(Array.from(f.query_ids.data),[0n,1n]);
assert.ok(Math.abs(f.query_features.data[0]-Math.log1p(2)/Math.log(129))<1e-7);
assert.deepEqual(Array.from(f.query_features.data.slice(1,8)),[0,1,1,-0.5,0.5,0,1]);
assert.deepEqual(Array.from(f.legal_category_mask.data.slice(0,32)),[...Array(16).fill(0),1,1,...Array(14).fill(0)]);
assert.equal(f.values.type,'float32');assert.equal(f.field_ids.type,'int64');assert.equal(f.history_mask.type,'bool');
const reordered={...example,queries:[example.queries[1],example.queries[0]]};
const rf=prepareExample(reordered,metadata,ort).feed;
assert.deepEqual(Array.from(rf.query_ids.data),[1n,0n]);
assert.deepEqual(Array.from(rf.query_features.data.slice(0,8)),Array.from(f.query_features.data.slice(8,16)));
assert.deepEqual(Array.from(rf.query_features.data.slice(8,16)),Array.from(f.query_features.data.slice(0,8)));
const subsetExample={fields:[example.fields[0]],history:[{score:60}],queries:[{field:'score'}]};
const subsetPrepared=prepareExample(subsetExample,metadata,ort);
assert.deepEqual(Array.from(subsetPrepared.feed.field_ids.data),[0n]);
assert.deepEqual(Array.from(subsetPrepared.feed.query_ids.data),[0n]);
assert.throws(()=>prepareExample({...subsetExample,queries:[{field:'score',minimum:-1}]},metadata,ort),/cannot widen/);
const rawArrays={quantiles:[[[[0.1,0.2,0.3]],[[0,0,0]]]],categorical:[[[0,1,0],[0,0,0]]],trend:[[[1,0,0],[0,1,0]]],failure:[[0,1]]};
// ONNX Runtime returns flat typed tensor data plus dimensions. Decoding these
// must match the equivalent nested-array path used by the reference helper.
const rawTensors=Object.fromEntries(Object.entries(rawArrays).map(([k,v])=>{
  const dims=k==='quantiles'?[1,2,1,3]:k==='categorical'?[1,2,3]:k==='trend'?[1,2,3]:[1,2];
  const flatten=a=>a.flatMap(x=>Array.isArray(x)?flatten(x):[x]);
  return [k,new Tensor('float32',Float32Array.from(flatten(v)),dims)];
}));
const arrDecoded=decodeOutputs(rawArrays,example,metadata,prepared);
const tensorDecoded=decodeOutputs(rawTensors,example,metadata,prepared);
const rounded=x=>typeof x==='number'?Number(x.toFixed(5)):Array.isArray(x)?x.map(rounded):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,rounded(v)])):x;
assert.deepEqual(rounded(tensorDecoded),rounded(arrDecoded));
assert.equal(arrDecoded[0].interval.calibrated,false);
assert.equal(arrDecoded[0].failure_calibrated,false);
assert.equal(arrDecoded[1].value,'ready');
assert.equal(arrDecoded[1].class_probability_calibrated,false);
const calibratedMetadata={...metadata,calibration:{risk_by_query:{typed_category:{field:'state',horizon:1,domain:{kind:'category',minimum:null,maximum:null,categories:['ready','late'],choices:[]},temperature:2,calibrated:true}}}};
const calibratedDecoded=decodeOutputs(rawArrays,example,calibratedMetadata,prepared);
assert.ok(Math.abs(calibratedDecoded[1].failure_probability-(1/(1+Math.exp(-0.5))))<1e-12);
assert.equal(calibratedDecoded[1].failure_calibrated,true);
assert.throws(()=>decodeOutputs({...rawTensors,failure:new Tensor('float32',Float32Array.of(NaN,0),[1,2])},example,metadata,prepared),/non-finite/);
const integerExample={fields:[{name:'n',kind:'integer',minimum:1.2,maximum:1.8}],history:[],queries:[{field:'n'}]};
const integerMeta={...metadata,fields:['n'],preprocessing:{n:[0,1]}};
assert.throws(()=>prepareExample(integerExample,integerMeta,ort),/no legal integer/);
const boundedExample={fields:[{name:'bounded',kind:'float',minimum:0,maximum:1}],history:[],queries:[{field:'bounded'}]};
const boundedMetadata={...metadata,fields:['bounded'],preprocessing:{bounded:[0,1]}};
const boundedPrepared=prepareExample(boundedExample,boundedMetadata,ort);
const numericOutput=(lo,mid,hi)=>({quantiles:[[[[lo,mid,hi]]]],categorical:[[Array(16).fill(0)]],trend:[[[1,0,0]]],failure:[[0]]});
assert.equal(decodeOutputs(numericOutput(-0.000001,-0.000001,0.000001),boundedExample,boundedMetadata,boundedPrepared)[0].value,0);
assert.throws(()=>decodeOutputs(numericOutput(1,1.1,1.2),boundedExample,boundedMetadata,boundedPrepared),/outside active schema bounds/);
const integerRoundingExample={fields:[{name:'n',kind:'integer',minimum:0,maximum:5}],history:[],queries:[{field:'n'}]};
const integerRoundingMeta={...metadata,fields:['n'],preprocessing:{n:[0,1]}};
const integerRoundingPrepared=prepareExample(integerRoundingExample,integerRoundingMeta,ort);
assert.equal(decodeOutputs(numericOutput(2.5,2.5,2.5),integerRoundingExample,integerRoundingMeta,integerRoundingPrepared)[0].value,2);
assert.equal(decodeOutputs(numericOutput(3.5,3.5,3.5),integerRoundingExample,integerRoundingMeta,integerRoundingPrepared)[0].value,4);

function readJson(relative) {
  return JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), relative), 'utf8'));
}
function collectSchemaSymbols(value, symbols) {
  if (Array.isArray(value)) value.forEach(item => collectSchemaSymbols(item, symbols));
  else if (value && typeof value === 'object') {
    Object.keys(value.properties || {}).forEach(key => symbols.add(key));
    (value.enum || []).filter(item => typeof item === 'string').forEach(item => symbols.add(item));
    if (typeof value.const === 'string') symbols.add(value.const);
    Object.values(value).forEach(item => collectSchemaSymbols(item, symbols));
  }
}
const appRootFromMobile = '../../../';
const grading = readJson(`${appRootFromMobile}packages/domain/src/grading/systems/it_global_grading_system.json`);
for (const component of grading.components) component.assessmentDefinition?.count && delete component.assessmentDefinition.count;
const assessmentComponent = type => grading.components.find(component => component.assessmentDefinition?.typeId === type);
const assessmentInstance = (ref, type, sequence, extra={}) => {
  const definition = assessmentComponent(type).assessmentDefinition;
  const maximum = definition.maxScore || 100;
  const scoring = definition.scoring.mode === 'linear'
    ? { mode: 'linear', maximum_score: maximum }
    : structuredClone(definition.scoring);
  return { assessment_ref:ref, assessment_type_ref:type, sequence, maximum_score:maximum, scoring, ...extra };
};
const socDefinition = assessmentComponent('soc').assessmentDefinition;
const lpDefinition = assessmentComponent('lp').assessmentDefinition;
const socMap = socDefinition.scoring.mapping;
const lpMap = lpDefinition.scoring.mapping;
const socValues = [socMap[0].value, socMap.at(-1).value, socMap[0].value];
const socPercent = socValues.map(value => socMap.find(row => row.value === value).percentage);
const lpObserved = lpMap.find(row => row.value === 1) || lpMap[0];
const lpValue = lpObserved.value;
const lpPercent = lpObserved.percentage;
const period = grading.periods[0];
const group = grading.groups.find(item => !Array.isArray(period?.groupIds) || period.groupIds.includes(item.id));
const scopeRefs = { ...(period ? {period_ref:period.id} : {}), ...(group ? {group_ref:group.id} : {}) };
const assessmentInstances = [
  assessmentInstance('soc-old','soc',0,scopeRefs),
  assessmentInstance('soc-tie-a','soc',1,scopeRefs),
  assessmentInstance('soc-tie-b','soc',1,scopeRefs),
  assessmentInstance('soc-query','soc',2,scopeRefs),
  assessmentInstance('lp-old','lp',0,scopeRefs),
  assessmentInstance('lp-query','lp',2,scopeRefs),
  assessmentInstance('cig-old','cig',0),
  assessmentInstance('cig-query','cig',2,{relative_day:-14,due_in_days:7}),
];
const socCategories = [...new Set(socMap.map(row => row.value))];
const mobileContextExample = {
  fields:[
    {name:'assessment_score',kind:'float',minimum:0,maximum:100},
    {name:'mapped_score',kind:'float',minimum:Math.min(...lpMap.map(row=>row.value)),maximum:Math.max(...lpMap.map(row=>row.value))},
    {name:'category_score',kind:'category',categories:socCategories},
  ],
  history:[{assessment_score:50}],
  queries:[
    {field:'category_score',horizon:1,assessment_ref:'soc-query'},
    {field:'mapped_score',horizon:1,assessment_ref:'lp-query'},
    {field:'assessment_score',horizon:1,assessment_ref:'cig-query'},
  ],
  schema:{gradingSystem:grading},
  assessment_instances:assessmentInstances,
  assessment_results:[
    {assessment_ref:'soc-old',value:socValues[0],observed_day:-10},
    {assessment_ref:'soc-tie-a',value:socValues[1],observed_day:-5},
    {assessment_ref:'soc-tie-b',value:socValues[2],observed_day:-5},
    {assessment_ref:'lp-old',value:lpValue,observed_day:-5},
    {assessment_ref:'cig-old',value:40,observed_day:-5},
  ],
};
const schemaSymbolSet = new Set(['gradingSystem','evaluationCriteria']);
collectSchemaSymbols(readJson(`${appRootFromMobile}packages/domain/src/grading/grading_system_schema.json`),schemaSymbolSet);
collectSchemaSymbols(readJson(`${appRootFromMobile}packages/domain/src/evaluation/evaluation_system_schema.json`),schemaSymbolSet);
const v1Metadata={
  ...metadata,
  fields:['assessment_score','mapped_score','category_score'],
  model_config:{...metadata.model_config,assessment_context_version:1},
  assessment_context_version:1,
  assessment_context_feature_names:[...ASSESSMENT_CONTEXT_FEATURE_NAMES],
  assessment_context_normalization_version:ASSESSMENT_CONTEXT_NORMALIZATION_VERSION,
  assessment_result_cutoff:ASSESSMENT_RESULT_CUTOFF,
  preprocessing:{assessment_score:[50,10],mapped_score:[0,1],category_score:[0,1]},
  schema_symbols:Object.fromEntries([...schemaSymbolSet].sort().map((name,index)=>[name,index+1])),
};
const v1Prepared=prepareExample(mobileContextExample,v1Metadata,ort);
const v1Features=Array.from(v1Prepared.feed.query_features.data);
assert.deepEqual(v1Prepared.feed.query_features.dims,[1,3,42]);
assert.equal(ASSESSMENT_CONTEXT_FEATURE_NAMES.length,34);
const v1Vector=(queryIndex)=>v1Features.slice(queryIndex*42+8,queryIndex*42+42);
const pythonContextExpected=readJson('./assessment-context-v1.expected.json');
for(let queryIndex=0;queryIndex<pythonContextExpected.length;queryIndex++) {
  assert.deepEqual(v1Vector(queryIndex),pythonContextExpected[queryIndex].map(Math.fround));
}
const socContext=v1Vector(0);
assert.equal(socContext[19],1);
assert.ok(Math.abs(socContext[20]-(socPercent[1]+socPercent[2])/200)<1e-7);
assert.ok(Math.abs(socContext[21]-socPercent.reduce((a,b)=>a+b,0)/300)<1e-7);
const populationStd=Math.sqrt(socPercent.reduce((sum,value)=>sum+(value-socPercent.reduce((a,b)=>a+b,0)/3)**2,0)/3);
assert.ok(Math.abs(socContext[22]-populationStd/100)<1e-7);
assert.ok(Math.abs(socContext[23]-((socPercent[1]+socPercent[2])/2-socPercent[0])/100)<1e-7);
assert.equal(socContext[24],1/512);
assert.ok(Math.abs(v1Vector(1)[20]-lpPercent/100)<1e-7);
assert.ok(Math.abs(v1Vector(2)[20]-0.4)<1e-7);
assert.equal(v1Vector(2)[25],1);
assert.equal(v1Vector(2)[27],1);
assert.ok(v1Vector(2)[26]<0&&v1Vector(2)[28]>0);
const reversedContextExample={...mobileContextExample,assessment_instances:[...assessmentInstances].reverse(),assessment_results:[...mobileContextExample.assessment_results].reverse()};
assert.deepEqual(Array.from(prepareExample(reversedContextExample,v1Metadata,ort).feed.query_features.data),v1Features);
const reorderedContextExample={...mobileContextExample,queries:[...mobileContextExample.queries].reverse()};
const reorderedFeatures=Array.from(prepareExample(reorderedContextExample,v1Metadata,ort).feed.query_features.data);
assert.deepEqual(reorderedFeatures.slice(0,42),v1Features.slice(84,126));
assert.deepEqual(reorderedFeatures.slice(84,126),v1Features.slice(0,42));
const renamedExample=structuredClone(mobileContextExample);
const referenceMap=new Map();
for(const [collection,prefix] of [['components','component'],['periods','period'],['groups','group'],['groupTypes','group-type'],['assessmentTypes','assessment-type']]){
  (renamedExample.schema.gradingSystem[collection]||[]).forEach((item,index)=>referenceMap.set(item.id,`opaque-${prefix}-${index}`));
}
const rewriteSchemaRefs=value=>{
  if(Array.isArray(value))value.forEach(rewriteSchemaRefs);
  else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){
    if(key==='id'&&referenceMap.has(child))value[key]=referenceMap.get(child);
    else if(['componentId','calculationRootComponentId','periodId','finalPeriodId','groupId','groupIds','parentGroupId','groupTypeId','typeId'].includes(key)){
      if(typeof child==='string'&&referenceMap.has(child))value[key]=referenceMap.get(child);
      else if(Array.isArray(child))value[key]=child.map(id=>referenceMap.get(id)||id);
      else rewriteSchemaRefs(child);
    }else rewriteSchemaRefs(child);
  }
};
rewriteSchemaRefs(renamedExample.schema.gradingSystem);
const assessmentRefMap=new Map(assessmentInstances.map((item,index)=>[item.assessment_ref,`private-assessment-${index}`]));
renamedExample.assessment_instances=renamedExample.assessment_instances.map(item=>({
  ...item,
  assessment_ref:assessmentRefMap.get(item.assessment_ref),
  assessment_type_ref:referenceMap.get(item.assessment_type_ref),
  ...(item.period_ref?{period_ref:referenceMap.get(item.period_ref)}:{}),
  ...(item.group_ref?{group_ref:referenceMap.get(item.group_ref)}:{}),
}));
renamedExample.assessment_results=renamedExample.assessment_results.map(item=>({...item,assessment_ref:assessmentRefMap.get(item.assessment_ref)}));
renamedExample.queries=renamedExample.queries.map(item=>({...item,assessment_ref:assessmentRefMap.get(item.assessment_ref)}));
const renamedPrepared=prepareExample(renamedExample,v1Metadata,ort);
assert.deepEqual(Array.from(renamedPrepared.feed.query_features.data),v1Features);
assert.deepEqual(Array.from(renamedPrepared.feed.schema_tokens.data),Array.from(v1Prepared.feed.schema_tokens.data));
const v0Metadata={...v1Metadata,model_config:{...v1Metadata.model_config,assessment_context_version:0},assessment_context_version:0};
delete v0Metadata.assessment_context_feature_names;
delete v0Metadata.assessment_context_normalization_version;
delete v0Metadata.assessment_result_cutoff;
assert.deepEqual(prepareExample(mobileContextExample,v0Metadata,ort).feed.query_features.dims,[1,3,8]);
// Assessment binding narrows the shared raw feature view to each concrete
// instance's legal score domain before any of the eleven tensors are built.
// This uses the raw query shape (no caller-provided bounds or choices).
const rawBindingInstances=[
  assessmentInstance('linear-10','cig',3,{maximum_score:10,scoring:{mode:'linear',maximum_score:10}}),
  assessmentInstance('linear-20','cig',4,{maximum_score:20,scoring:{mode:'linear',maximum_score:20}}),
  assessmentInstance('linear-100','cig',5,{maximum_score:100,scoring:{mode:'linear',maximum_score:100}}),
  assessmentInstance('numeric-map','lp',6),
  assessmentInstance('value-map','soc',7),
];
const rawBindingExample={
  fields:[
    {name:'assessment_score',kind:'float',minimum:0,maximum:100},
    {name:'mapped_score',kind:'float',minimum:0,maximum:100},
    {name:'category_score',kind:'category',categories:['unrelated-local-category']},
  ],history:[],
  queries:[
    {field:'assessment_score',assessment_ref:'linear-10'},
    {field:'assessment_score',assessment_ref:'linear-20'},
    {field:'assessment_score',assessment_ref:'linear-100'},
    {field:'mapped_score',assessment_ref:'numeric-map'},
    {field:'category_score',assessment_ref:'value-map'},
  ],schema:{gradingSystem:grading},assessment_instances:rawBindingInstances,assessment_results:[],
};
const rawBindingMetadata={...v0Metadata,fields:['assessment_score','mapped_score','category_score'],preprocessing:{assessment_score:[0,1],mapped_score:[0,1],category_score:[0,1]}};
const boundRaw=prepareExample(rawBindingExample,rawBindingMetadata,ort), boundFeed=boundRaw.feed;
assert.deepEqual(Object.keys(boundFeed),inputNames);
assert.deepEqual(boundFeed.query_features.dims,[1,5,8]);
assert.deepEqual(boundFeed.values.dims,[1,1]);
assert.deepEqual(Array.from(boundFeed.values.data),[0]);
assert.deepEqual(Array.from(boundFeed.field_ids.data),[0n]);
assert.deepEqual(Array.from(boundFeed.kinds.data),[4n]);
assert.deepEqual(boundFeed.schema_tokens.dims,[1,boundFeed.schema_tokens.dims[1],16]);
assert.ok(boundFeed.schema_tokens.data.every(Number.isFinite));
assert.deepEqual(Array.from(boundFeed.history_mask.data),[0]);
assert.deepEqual(Array.from(boundFeed.query_ids.data),[0n,0n,0n,1n,2n]);
assert.deepEqual(Array.from(boundFeed.query_mask.data),[0,0,0,0,0]);
assert.deepEqual(boundFeed.legal_category_mask.dims,[1,5,16]);
assert.equal(boundFeed.schema_mask.dims[1],boundFeed.schema_tokens.dims[1]);
assert.deepEqual(Array.from(boundFeed.numeric_bounds.data).slice(0,6),[0,10,0,20,0,100]);
assert.deepEqual(boundRaw.example.queries[3].choices,lpMap.map(row=>row.value));
assert.deepEqual(Array.from(boundFeed.numeric_bounds.data).slice(6,8),[
  Math.min(...lpMap.map(row=>row.value)),
  Math.min(Math.max(...lpMap.map(row=>row.value)),rawBindingInstances[3].maximum_score),
]);
assert.deepEqual(boundRaw.example.queries[4].choices,socMap.map(row=>row.value));
assert.deepEqual(boundRaw.example.fields[2].categories,['unrelated-local-category',...socMap.map(row=>row.value)]);
assert.equal(Array.from(boundFeed.legal_category_mask.data).slice(4*16,5*16).filter(Boolean).length,socMap.length);
assert.equal(Array.from(boundFeed.query_features.data)[3*8+1],4);
const narrowedChoicesRaw={...rawBindingExample,queries:[
  ...rawBindingExample.queries.slice(0,3),
  {...rawBindingExample.queries[3],choices:[lpMap[0].value]},
  {...rawBindingExample.queries[4],choices:[socMap[0].value]},
]};
const narrowedChoicesPrepared=prepareExample(narrowedChoicesRaw,rawBindingMetadata,ort);
assert.deepEqual(narrowedChoicesPrepared.example.queries[3].choices,[lpMap[0].value]);
assert.deepEqual(narrowedChoicesPrepared.example.queries[4].choices,[socMap[0].value]);
assert.equal(Array.from(narrowedChoicesPrepared.feed.legal_category_mask.data).slice(3*16,4*16).filter(Boolean).length,1);
assert.equal(Array.from(narrowedChoicesPrepared.feed.legal_category_mask.data).slice(4*16,5*16).filter(Boolean).length,1);
// The binder's request-local updates do not rewrite typed caller data.
assert.equal(rawBindingExample.fields[2].categories.length,1);
assert.equal(rawBindingExample.queries[0].maximum,undefined);
const narrowedRaw={...rawBindingExample,queries:[{...rawBindingExample.queries[0],minimum:2,maximum:8},{...rawBindingExample.queries[1]},...rawBindingExample.queries.slice(2)]};
assert.deepEqual(Array.from(prepareExample(narrowedRaw,rawBindingMetadata,ort).feed.numeric_bounds.data).slice(0,2),[2,8]);
assert.deepEqual(Array.from(prepareExample({...rawBindingExample,queries:[{...rawBindingExample.queries[0],maximum:101},...rawBindingExample.queries.slice(1)]},rawBindingMetadata,ort).feed.numeric_bounds.data).slice(0,2),[0,10]);
assert.throws(()=>prepareExample({...rawBindingExample,queries:[{...rawBindingExample.queries[0],choices:[101]},...rawBindingExample.queries.slice(1)]},rawBindingMetadata,ort),/widen|outside|domain/i);
const rawBindingV1Metadata={
  ...rawBindingMetadata,
  model_config:{...rawBindingMetadata.model_config,assessment_context_version:1},
  assessment_context_version:1,
  assessment_context_feature_names:[...ASSESSMENT_CONTEXT_FEATURE_NAMES],
  assessment_context_normalization_version:ASSESSMENT_CONTEXT_NORMALIZATION_VERSION,
  assessment_result_cutoff:ASSESSMENT_RESULT_CUTOFF,
};
const boundRawV1=prepareExample(rawBindingExample,rawBindingV1Metadata,ort);
assert.deepEqual(boundRawV1.feed.query_features.dims,[1,5,42]);
assert.deepEqual(Array.from(boundRawV1.feed.numeric_bounds.data),Array.from(boundFeed.numeric_bounds.data));
assert.deepEqual(Array.from(boundRawV1.feed.legal_category_mask.data),Array.from(boundFeed.legal_category_mask.data));
const unknownTime={...mobileContextExample,queries:[{field:'category_score',assessment_ref:'soc-query'}],fields:[mobileContextExample.fields[2]],history:[],assessment_results:[...mobileContextExample.assessment_results,{assessment_ref:'soc-query',value:socValues[0],observed_day:null}]};
assert.throws(()=>prepareExample(unknownTime,v1Metadata,ort),/recorded result/);
assert.throws(()=>prepareExample(mobileContextExample,{...v1Metadata,assessment_context_normalization_version:'wrong'},ort),/normalization version/);
assert.throws(()=>prepareExample({...mobileContextExample,assessment_instances:assessmentInstances.map((item,index)=>index===7?{...item,sequence:NaN}:item)},v1Metadata,ort),/finite/);
console.log('mobile encoder fixture and query order checks passed');
