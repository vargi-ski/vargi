const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {buildMessage, linksFor} = require('../assets/camp-signup.js');
const {isActive,isDismissed,isExcluded,END_AT,COOLDOWN} = require('../assets/camp-promo.js');
const base = {room:'double',participants:1,level:'marathon',comment:''};

test('application carries exact dates, package, room, experience and Unicode comments', () => {
  const message=buildMessage({...base,room:'family',participants:3,comment:'Семья & дети + лыжи 🐺'});
  assert.match(message,/26 ноября — 5 декабря 2026/);
  assert.match(message,/115 000 ₽/);
  assert.match(message,/Семейное · стоимость по запросу/);
  assert.match(message,/Планирует приехать: 3/);
  assert.match(message,/Семья & дети \+ лыжи 🐺/);
  assert.doesNotMatch(message,/345 000|место забронировано/i);
  const links=linksFor(message);
  const direct=new URL(links.direct), embedded=new URL(links.embedded);
  assert.equal(direct.origin,'https://forms.yandex.ru');
  assert.equal(direct.searchParams.get('message'),message);
  assert.equal(direct.searchParams.get('answer_choices_96193'),'85177');
  assert.equal(direct.searchParams.has('answer_boolean_9008988974137832'),false);
  assert.equal(embedded.searchParams.get('message'),message);
  assert.equal(embedded.searchParams.get('iframe'),'1');
  assert.equal(direct.searchParams.has('iframe'),false);
  assert.equal(new URL(links.telegram).searchParams.get('text'),message);
  assert.ok(embedded.href.length < 32000);
});
test('rejects invalid choices, fractional counts and overly long comments', () => {
  for (const data of [{room:'__proto__'},{level:'missing'},{participants:0},{participants:1.5},{participants:21},{comment:'я'.repeat(501)}]) assert.throws(()=>buildMessage({...base,...data}));
});
test('promo excludes application/contact/admin flows and remains on public entries', () => {
  for (const url of ['/camps/first-snow/','/camps/first-snow/signup/','/board/submit/','/board/admin/','/shop/order/','/privacy.html','/contact/','/analytics-dashboard/']) assert.equal(isExcluded(url,''),true,url);
  for (const url of ['/','/team/','/camps/','/shop/','/board/']) assert.equal(isExcluded(url,''),false,url);
  assert.equal(isExcluded('/','#signup'),true);
  assert.equal(isExcluded('/','#message=hello'),true);
});
test('promo respects Moscow start time and exact cooldown boundary', () => {
  assert.equal(END_AT,Date.parse('2026-11-25T21:00:00Z'));
  assert.equal(isActive(END_AT-1),true);
  assert.equal(isActive(END_AT),false);
  const dismissed=Date.parse('2026-10-12T12:00:00Z');
  assert.equal(isDismissed(String(dismissed),dismissed+COOLDOWN-1),true);
  assert.equal(isDismissed(String(dismissed),dismissed+COOLDOWN),false);
  assert.equal(isDismissed(null,dismissed),false);
  assert.equal(isDismissed('broken',dismissed),false);
});

function fixture(storageThrows=false) {
  const elements = {};
  const ids=['campBuilder','campCheckout','campRoom','campParticipants','campLevel','campComment','campError','campSummary','openCampForm','telegramCamp','campForm','checkoutHeading','editCamp'];
  for(const id of ids)elements[id]={hidden:true,value:'',events:{},srcWrites:0,addEventListener(type,fn){this.events[type]=fn;},reportValidity(){return true;},focus(){this.focused=true;},scrollIntoView(){},set src(v){this._src=v;this.srcWrites++;},get src(){return this._src;}};
  elements.campRoom.value='double';elements.campParticipants.value='1';elements.campLevel.value='amateur';
  const storage=new Map();let confirmResult=true;
  const win={document:{getElementById:id=>elements[id]},sessionStorage:{getItem(k){if(storageThrows)throw Error('blocked');return storage.get(k);},setItem(k,v){if(storageThrows)throw Error('blocked');storage.set(k,v);}},confirm:()=>confirmResult};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/camp-signup.js'),'utf8'),{window:win,URL});
  return {elements,storage,confirm(value){confirmResult=value;},submit(){elements.campBuilder.events.submit({preventDefault(){}});},edit(){elements.editCamp.events.click();}};
}
test('contact step keeps iframe when revisiting unchanged request and never claims sent', () => {
  const f=fixture();const e=f.elements;
  assert.equal(e.campBuilder.hidden,false);f.submit();
  assert.equal(e.campBuilder.hidden,true);assert.equal(e.campCheckout.hidden,false);
  assert.equal(e.campForm.srcWrites,1);assert.equal(e.checkoutHeading.focused,true);
  f.edit();f.submit();assert.equal(e.campForm.srcWrites,1);
  f.edit();e.campRoom.value='single';f.confirm(false);f.submit();
  assert.equal(e.campForm.srcWrites,1);assert.equal(e.campBuilder.hidden,false);
  f.confirm(true);f.submit();assert.equal(e.campForm.srcWrites,2);
  assert.match(new URL(e.openCampForm.href).searchParams.get('message'),/Одноместное/);
});
test('blocked storage does not stop signup; no comments or contacts are persisted', () => {
  const f=fixture(true);f.submit();assert.equal(f.elements.campCheckout.hidden,false);
  const g=fixture();g.elements.campComment.value='Комментарий';g.submit();
  const saved=JSON.parse([...g.storage.values()][0]);
  assert.deepEqual(Object.keys(saved).sort(),['level','participants','room']);
});
