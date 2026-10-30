import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compare } from '../src/compare.mjs';

function doc(schema = { type: 'object', properties: { name: {type:'string'} }, required:['name'] }, direction = 'response') {
  const op = { responses: { '200': {description:'ok'} } };
  if (direction === 'response') op.responses['200'].content = {'application/json':{schema}};
  else op.requestBody = { content: {'application/json':{schema}} };
  return {openapi:'3.0.3', info:{title:'Synthetic test API',version:'1'}, paths:{'/users':{post:op}}};
}
const clone = x => structuredClone(x);
const codes = r => r.findings.map(f=>f.code);

test('identical ordinary contract passes without findings', () => {
  assert.deepEqual(compare(doc(), doc()), {breaking:0,review:0,findings:[]});
});
test('removed paths and operations break', () => {
  const next = doc(); next.paths = {};
  assert.ok(codes(compare(doc(), next)).includes('path-removed'));
  next.paths = {'/users':{}};
  assert.ok(codes(compare(doc(), next)).includes('operation-removed'));
});
test('required request field addition breaks but removing requirement does not', () => {
  const optional = {type:'object', properties:{name:{type:'string'}}, required:[]};
  assert.ok(codes(compare(doc(optional,'request'),doc(undefined,'request'))).includes('required-added'));
  assert.equal(compare(doc(undefined,'request'),doc(optional,'request')).breaking, 0);
});
test('response requiredness is the inverse of request requiredness', () => {
  const optional = {type:'object', properties:{name:{type:'string'}},required:[]};
  assert.ok(codes(compare(doc(),doc(optional))).includes('required-removed'));
  assert.equal(compare(doc(optional), doc()).breaking, 0);
});
test('nested array item types are checked', () => {
  const a={type:'array',items:{type:'object',properties:{value:{type:'string'}}}};
  const b=clone(a); b.items.properties.value.type='number';
  const r=compare(doc(a),doc(b));
  assert.ok(r.findings.some(f=>f.code==='schema-type'&&f.path.endsWith('/items/properties/value')));
});
test('request enum narrowing and response enum widening break', () => {
  const a={type:'string',enum:['a','b']},b={type:'string',enum:['a']};
  assert.equal(compare(doc(a,'request'),doc(b,'request')).breaking,1);
  assert.equal(compare(doc(b,'request'),doc(a,'request')).breaking,0);
  assert.equal(compare(doc(b),doc(a)).breaking,1);
  assert.equal(compare(doc(a),doc(b)).breaking,0);
});
test('nullable checks depend on direction', () => {
  const a={type:'string',nullable:true},b={type:'string'};
  assert.equal(compare(doc(a,'request'),doc(b,'request')).breaking,1);
  assert.equal(compare(doc(b),doc(a)).breaking,1);
  assert.equal(compare(doc(a),doc(b)).breaking,0);
});
test('shared schema references are compared even when reference strings are identical', () => {
  const before=doc({$ref:'#/components/schemas/User'}),after=clone(before);
  before.components={schemas:{User:{type:'string'}}};
  after.components={schemas:{User:{type:'integer'}}};
  assert.ok(codes(compare(before,after)).includes('schema-type'));
});
test('broken and external references require review, never a clean result', () => {
  for(const ref of ['#/missing','https://example.invalid/schema.json']) {
    const r=compare(doc({$ref:ref}),doc({$ref:ref}));
    assert.ok(r.review>0);
  }
});
test('recursive schema terminates and requires review', () => {
  const before=doc({$ref:'#/components/schemas/Node'});
  before.components={schemas:{Node:{type:'object',properties:{child:{$ref:'#/components/schemas/Node'}}}}};
  assert.ok(compare(before,clone(before)).review>0);
});
test('JSON Pointer escaped property names resolve', () => {
  const before=doc({$ref:'#/components/schemas/a~1b~0c'}),after=clone(before);
  before.components={schemas:{'a/b~c':{type:'string'}}};
  after.components={schemas:{'a/b~c':{type:'number'}}};
  assert.ok(compare(before,after).breaking>0);
});
test('parameter inheritance is overridden by the operation', () => {
  const before=doc(),after=doc();
  before.paths['/users'].parameters=[{in:'query',name:'limit',required:true,schema:{type:'integer'}}];
  after.paths['/users'].parameters=clone(before.paths['/users'].parameters);
  before.paths['/users'].post.parameters=[{in:'query',name:'limit',required:false,schema:{type:'integer'}}];
  assert.ok(codes(compare(before,after)).includes('parameter-required'));
});
test('new optional parameters are compatible', () => {
  const after=doc(); after.paths['/users'].post.parameters=[{in:'query',name:'filter',schema:{type:'string'}}];
  assert.equal(compare(doc(),after).breaking,0);
  after.paths['/users'].post.parameters[0].required=true;
  assert.ok(codes(compare(doc(),after)).includes('parameter-added'));
});
test('required body and removed media type break', () => {
  const before=doc(undefined,'request'),after=clone(before);
  after.paths['/users'].post.requestBody.required=true;
  assert.ok(codes(compare(before,after)).includes('body-required'));
  after.paths['/users'].post.requestBody.content={};
  assert.ok(codes(compare(before,after)).includes('media-removed'));
});
test('removed response properties and status are detected', () => {
  assert.ok(codes(compare(doc(),doc({type:'object'}))).includes('property-removed'));
  const after=doc(); after.paths['/users'].post.responses={};
  assert.ok(codes(compare(doc(),after)).includes('response-removed'));
});
test('description edits and object key order do not create false positives', () => {
  const before=doc({type:'string',description:'old',enum:['a']}),after=doc({enum:['a'],description:'new',type:'string'});
  assert.equal(compare(before,after).findings.length,0);
});
test('unsupported keyword changes and composition need review', () => {
  assert.ok(compare(doc({type:'string',maxLength:20}),doc({type:'string',maxLength:10})).review>0);
  const composed=doc({oneOf:[{type:'string'},{type:'number'}]});
  assert.ok(compare(composed,composed).review>0);
});
test('unknown OpenAPI versions and malformed documents fail closed', () => {
  for(const invalid of [null,{}, {...doc(),openapi:'3.1.0'}, {...doc(),paths:[]}]) assert.throws(()=>compare(invalid,doc()));
});
test('CLI emits machine-readable findings and exit 1 for breaking changes', () => {
  const run=spawnSync(process.execPath,['src/cli.mjs','examples/before.json','examples/after.json','--json'],{encoding:'utf8'});
  assert.equal(run.status,1,run.stderr);
  assert.ok(JSON.parse(run.stdout).breaking>0);
});
test('CLI has successful and invalid-input exit codes', () => {
  assert.equal(spawnSync(process.execPath,['src/cli.mjs','examples/before.json','examples/before.json']).status,0);
  assert.equal(spawnSync(process.execPath,['src/cli.mjs','missing.json','missing.json']).status,2);
});
test('unchanged security requirement with changed scheme still requires review', () => {
  const before=doc(),after=doc(); before.components={securitySchemes:{auth:{type:'http',scheme:'basic'}}};
  after.components={securitySchemes:{auth:{type:'http',scheme:'bearer'}}};
  assert.ok(codes(compare(before,after)).includes('security-schemes'));
});
test('new request property constraint and response media type require review', () => {
  const before=doc({type:'object'},'request'),after=doc({type:'object',properties:{age:{type:'integer'}}},'request');
  assert.ok(codes(compare(before,after)).includes('new-property-constraint'));
  const next=doc();next.paths['/users'].post.responses['200'].content['text/plain']={schema:{type:'string'}};
  assert.ok(codes(compare(doc(),next)).includes('response-media-added'));
});
