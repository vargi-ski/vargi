const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {parseMeasurement, resolveSize, readDraft} = require('../assets/shop-order.js');
const preorder = {id:'warmup-suit',preorder:true,sizeKind:'clothing'};
const stock = {id:'shirt-classic',sizeKind:'clothing',stock:{M:2}};
const cap = {id:'cap',preorder:true,sizeKind:'cap'};

test('preorder proceeds with measurements alone, with size or with explicit help', () => {
  assert.equal(resolveSize(preorder,'',false,[180,100,null,null]),'Подобрать по указанным меркам');
  assert.equal(resolveSize(preorder,' M ',false,[]),'M');
  assert.equal(resolveSize(preorder,'',true,[]),'Нужна помощь с размером');
  assert.equal(resolveSize(preorder,'',false,[null,NaN]),'');
});
test('measurement fallback does not bypass stock sizes or cap requirements', () => {
  assert.equal(resolveSize(stock,'',false,[180]),'');
  assert.equal(resolveSize(cap,'',false,[58]),'');
  assert.equal(resolveSize(stock,'M',false,[]),'M');
  assert.equal(resolveSize(cap,'58',false,[]),'58');
});
test('Russian decimal comma and decimal point retain the same measurement', () => {
  for (const [value,expected] of [['180',180],['100,5',100.5],['100.5',100.5],[' 84 ',84],['1',1],['300',300]]) assert.equal(parseMeasurement(value),expected);
  assert.equal(parseMeasurement(''),null);
  assert.equal(parseMeasurement('  '),null);
  for (const value of ['0','301','-1','100,55','1e2','180 см','Infinity','100..5','<script>']) assert.ok(Number.isNaN(parseMeasurement(value)),value);
});
const now=Date.parse('2026-10-21T18:00:00Z');
const line={product:'warmup-suit',size:'M',quantity:'2',help:false,measurements:['180','100,5','','']};
const encoded=items=>JSON.stringify({version:1,updatedAt:now,items});
test('draft restores choices, multiple rows and raw decimal input without contacts', () => {
  assert.deepEqual(readDraft(encoded([line,{...line,help:true}]),[preorder],now),[line,{...line,help:true}]);
  const result=readDraft(encoded([{...line,email:'not-persisted',name:'not-persisted'}]),[preorder],now);
  assert.deepEqual(Object.keys(result[0]).sort(),['help','measurements','product','quantity','size']);
});
test('draft rejects corruption, future/expired timestamps, unknown versions and excessive rows', () => {
  for (const raw of [null,'broken','{}',JSON.stringify({version:2,updatedAt:now,items:[line]}),encoded([]),encoded(Array(11).fill(line))]) assert.equal(readDraft(raw,[preorder],now),null);
  assert.equal(readDraft(encoded([line]),[preorder],now+86400001),null);
  assert.equal(readDraft(encoded([line]),[preorder],now-1),null);
  assert.equal(readDraft(encoded([line]),[stock],now),null);
  assert.deepEqual(readDraft(encoded([line,{product:'removed'}]),[preorder],now),[line]);
});
test('untrusted draft values are bounded and prices are never restored from storage', () => {
  const result=readDraft(encoded([{...line,size:'x'.repeat(300),quantity:'x'.repeat(100),measurements:['x'.repeat(50)],price:1}]),[preorder],now)[0];
  assert.equal(result.size.length,40);assert.equal(result.quantity.length,8);
  assert.deepEqual(result.measurements,['x'.repeat(20),'','','']);
  assert.equal(result.price,undefined);
});
test('controller intercepts submit before native required-field validation and keeps an explicit checkout scroll', () => {
  const js=fs.readFileSync(path.join(__dirname,'../assets/shop-order.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'../shop/order/index.html'),'utf8');
  assert.match(js,/builder\.noValidate = true/);
  assert.doesNotMatch(js,/reportValidity\(/);
  assert.match(js,/event\.preventDefault\(\)/);
  assert.match(js,/checkout\.scrollIntoView/);
  assert.match(js,/sessionStorage\.setItem/);
  assert.match(html,/id="draftStatus"/);
  assert.match(html,/class="field-error error"/);
  assert.equal((html.match(/type="text" class="measurement"/g)||[]).length,4);
});
