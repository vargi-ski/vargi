const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/contact-form.js'),'utf8');

function links(hash='') {
  const elements={openForm:{},contactForm:{src:'https://forms.yandex.ru/u/6aacf2a849af472ed76c9d3d?message=old-camp&vargi_camp=first-snow-2026'},telegramContact:{}};
  vm.runInNewContext(source,{window:{location:{hash}},document:{getElementById:id=>elements[id]},URL,URLSearchParams});
  return {direct:new URL(elements.openForm.href),embedded:new URL(elements.contactForm.src),telegram:new URL(elements.telegramContact.href)};
}

test('plain contact route explicitly replaces camp routing and empty prefill fields',()=>{
  const result=links();
  for(const url of [result.direct,result.embedded]) {
    assert.equal(url.searchParams.get('vargi_camp'),'contact');
    assert.equal(url.searchParams.has('message'),true);
    assert.equal(url.searchParams.get('message'),'');
    assert.equal(url.searchParams.has('answer_choices_96193'),true);
    assert.equal(url.searchParams.get('answer_choices_96193'),'');
    assert.equal(url.searchParams.has('answer_boolean_9008988974137832'),false,'consent must be chosen by the visitor');
  }
  assert.equal(result.embedded.searchParams.get('iframe'),'1');
  assert.equal(result.direct.searchParams.has('iframe'),false);
  assert.equal(result.telegram.searchParams.has('text'),false);
});

test('source message survives exactly and cannot override the contact route',()=>{
  const message='Вступление в стаю — город: Тест & опыт: 3+ года 🐺';
  const result=links('#message='+encodeURIComponent(message)+'&vargi_camp=first-snow-2026&answer_choices_96193=85177');
  for(const url of [result.direct,result.embedded]) {
    assert.equal(url.searchParams.get('message'),message);
    assert.equal(url.searchParams.get('vargi_camp'),'contact');
    assert.equal(url.searchParams.get('answer_choices_96193'),'');
  }
  assert.equal(result.telegram.searchParams.get('text'),message);
});

test('excessively long source message is bounded for both form and Telegram',()=>{
  const result=links('#message='+encodeURIComponent('А'.repeat(4000)));
  assert.equal(result.embedded.searchParams.get('message').length,3500);
  assert.equal(result.telegram.searchParams.get('text').length,3500);
});

test('contact links route correctly even when site JavaScript is disabled',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../contact/index.html'),'utf8');
  const iframe=html.match(/<iframe\b[^>]*\bid="contactForm"[^>]*\bsrc="([^"]+)"/)[1];
  const fallback=html.match(/<a\b[^>]*\bid="openForm"[^>]*\bhref="([^"]+)"/)[1];
  for(const value of [iframe,fallback]) {
    const url=new URL(value.replaceAll('&amp;','&'));
    assert.equal(url.searchParams.get('vargi_camp'),'contact');
    assert.equal(url.searchParams.get('message'),'');
    assert.equal(url.searchParams.get('answer_choices_96193'),'');
  }
});
