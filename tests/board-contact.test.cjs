const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'board/submit/index.html'), 'utf8');

function fixture() {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, {classList:{add(){},remove(){}},disabled:false});
    return elements.get(selector);
  };
  const sent = [];
  const scope = vm.createContext({$, URL, FormData, photos:[{file:new File(['synthetic photo'],'test.jpg')}],
    photoRevision:1, current:null, preparedSubmission:null, draftTimer:null, draftEnabled:true,
    kinds:{sell:'Продаю'},categories:{clothes:'Одежда и аксессуары'},
    priceText:()=> '1 000 ₽', newRequestId:()=> 'synthetic-request-id', saveDraft:async()=>{},
    scrollTo(){},clearTimeout(){},location:{},checkConnection(){},
    VargiDraft:{clear:async()=>{}},VargiConnection:{send:async data=>sent.push(data)}
  });
  vm.runInContext(page.slice(page.indexOf('function collect('),page.indexOf('function failForm(')),scope);
  vm.runInContext(page.slice(page.indexOf("$('#sendButton').onclick="),page.indexOf('let draftTimer,')),scope);
  return {scope,$,sent};
}

for (const phone of ['', '+7 (000) 000-00-00']) {
  test('optional phone survives preview and send without changing public contact: '+(phone?'filled':'empty'),async()=>{
    const f=fixture();
    f.scope.order={kind:'sell',category:'clothes',title:'ТЕСТ',city:'Тест',price:1000,
      description:'Тестовое описание',contactName:'Тест',publicContact:'@public_contact',contactPhone:phone};
    vm.runInContext('showPreview(order)',f.scope);
    await f.$('#sendButton').onclick();
    assert.equal(f.sent.length,1);
    const data=f.sent[0];
    assert.equal(data.get('publicContact'),'@public_contact');
    assert.equal(data.get('description'),'Тестовое описание');
    if(phone) {
      assert.ok(data.get('message').includes('Телефон для связи с модератором (не публиковать): '+phone));
      assert.ok(new URL(f.$('#telegramButton').href).searchParams.get('text').includes(phone));
    } else assert.ok(!data.get('message').includes('Телефон для связи с модератором'));
  });
}

test('moderator message with a private phone is excluded from the public listing',()=>{
  const server=fs.readFileSync(path.join(root,'market-api/server.js'),'utf8');
  const scope=vm.createContext({publicBase:()=> 'https://example.invalid',categoryKeyFor:()=> 'clothes',
    listingDescription:item=>item.description});
  const source=server.match(/function publicListing\([\s\S]*?\n\}/)[0];
  vm.runInContext(source,scope);
  scope.item={id:'synthetic',priceValue:1000,description:'Товар',contact:'Тест — @public_contact',
    publicContact:'@public_contact',message:'Телефон для связи с модератором (не публиковать): +7 (000) 000-00-00'};
  const publicData=vm.runInContext('publicListing(item, {})',scope);
  assert.equal(publicData.publicContact,'@public_contact');
  assert.equal('message' in publicData,false);
  assert.ok(!JSON.stringify(publicData).includes('+7 (000)'));
});
