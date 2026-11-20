const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../assets/join-staya.js'),'utf8');
const roleKey='answer_choices_9008994414934764';
function links(search=''){
  const elements={openJoinForm:{},joinForm:{}};
  vm.runInNewContext(source,{window:{location:{search}},document:{getElementById:id=>elements[id]},URL,URLSearchParams});
  return [new URL(elements.openJoinForm.href),new URL(elements.joinForm.src)];
}
test('new join form enables required participation choice without choosing for the visitor',()=>{
  const [direct,embedded]=links();
  for(const url of [direct,embedded]){
    assert.equal(url.searchParams.get('vargi_join'),'1');
    assert.equal(url.searchParams.get('vargi_camp'),'contact');
    assert.equal(url.searchParams.get('answer_choices_96193'),'85175');
    assert.equal(url.searchParams.get(roleKey),'');
    assert.equal(url.searchParams.get('message'),'');
    assert.equal(url.searchParams.has('answer_boolean_9008988974137832'),false);
  }
  assert.equal(direct.searchParams.has('iframe'),false);
  assert.equal(embedded.searchParams.get('iframe'),'1');
});
test('only known participation formats can be preselected',()=>{
  for(const [format,id] of Object.entries({main:'9008994414934774',expanded:'1795160263095',community:'1795160271723'})){
    for(const url of links('?format='+format))assert.equal(url.searchParams.get(roleKey),id);
  }
  for(const format of ['unknown','__proto__','constructor','toString']){
    for(const url of links('?format='+format))assert.equal(url.searchParams.get(roleKey),'');
  }
});
test('query parameters cannot override webhook route, inject contacts or supply consent',()=>{
  for(const url of links('?format=community&vargi_join=0&vargi_camp=first-snow-2026&message=old&email=unexpected&answer_boolean_9008988974137832=true')){
    assert.equal(url.searchParams.get('vargi_camp'),'contact');
    assert.equal(url.searchParams.get('vargi_join'),'1');
    assert.equal(url.searchParams.get('message'),'');
    assert.equal(url.searchParams.has('email'),false);
    assert.equal(url.searchParams.has('answer_boolean_9008988974137832'),false);
  }
});
test('join route and fallback work without JavaScript and have a canonical address',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../join/index.html'),'utf8');
  const values=[html.match(/<iframe\b[^>]*\bid="joinForm"[^>]*\bsrc="([^"]+)"/)[1],html.match(/<a\b[^>]*\bid="openJoinForm"[^>]*\bhref="([^"]+)"/)[1]];
  for(const value of values){const url=new URL(value.replaceAll('&amp;','&'));assert.equal(url.searchParams.get('vargi_join'),'1');assert.equal(url.searchParams.get('vargi_camp'),'contact');assert.equal(url.searchParams.get(roleKey),'');}
  assert.match(html,/<link rel="canonical" href="https:\/\/xn----7sbbfg4a6clj5k.xn--p1ai\/join\/">/);
  assert.match(fs.readFileSync(path.join(__dirname,'../sitemap.xml'),'utf8'),/xn----7sbbfg4a6clj5k.xn--p1ai\/join\//);
});
test('camp form clears any saved join marker and selection while retaining camp route',()=>{
  const {linksFor}=require('../assets/camp-signup.js');
  const result=linksFor('ЗАЯВКА НА КЕМП');
  for(const value of [result.direct,result.embedded]){
    const url=new URL(value);
    assert.equal(url.searchParams.get('vargi_join'),'');
    assert.equal(url.searchParams.get(roleKey),'');
    assert.equal(url.searchParams.get('vargi_camp'),'first-snow-2026');
    assert.equal(url.searchParams.get('message'),'ЗАЯВКА НА КЕМП');
  }
});
