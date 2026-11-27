const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {linksFor} = require('../assets/camp-signup.js');

function run(asset, location = {}) {
  const elements = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/', asset), 'utf8'), {
    window: {location: {search: '', hash: '', ...location}},
    document: {getElementById: id => elements[id] ||= {}}, URL, URLSearchParams
  });
  return elements;
}
function pairs() {
  const join = run('join-staya.js');
  const contact = run('contact-form.js');
  const prefilled = run('contact-form.js', {hash: '#message=' + encodeURIComponent('ОБЪЯВЛЕНИЕ ВАРГИ — тестовый черновик')});
  const camp = linksFor('ЗАЯВКА НА КЕМП — тестовые условия');
  return {
    join: [join.openJoinForm.href, join.joinForm.src],
    contact: [contact.openForm.href, contact.contactForm.src],
    prefilled: [prefilled.openForm.href, prefilled.contactForm.src],
    camp: [camp.direct, camp.embedded]
  };
}
test('shared Yandex form keeps four separate draft stores; direct and embedded links agree', () => {
  const keys = [];
  for (const [kind, values] of Object.entries(pairs())) {
    const urls = values.map(value => new URL(value));
    const key = urls[0].searchParams.get('form:cache_key');
    assert.match(key, /^[a-zA-Z0-9_-]{3,50}$/);
    assert.equal(urls[1].searchParams.get('form:cache_key'), key, kind);
    assert.equal(urls[0].pathname, '/u/6aacf2a849af472ed76c9d3d');
    keys.push(key);
  }
  assert.equal(new Set(keys).size, 4, 'board prefills must not become join, contact or camp drafts');
});
test('draft routing ignores caller-supplied keys and preserves the valid join draft across format changes', () => {
  const key = new URL(pairs().join[0]).searchParams.get('form:cache_key');
  for (const format of ['main', 'expanded', 'community', 'unknown']) {
    const result = run('join-staya.js', {search: '?format=' + format + '&form%3Acache_key=vargi-contact-prefill-v1'});
    assert.equal(new URL(result.joinForm.src).searchParams.get('form:cache_key'), key);
  }
  const result = run('contact-form.js', {hash: '#form%3Acache_key=vargi-join-v1'});
  assert.equal(new URL(result.contactForm.src).searchParams.get('form:cache_key'), new URL(pairs().contact[0]).searchParams.get('form:cache_key'));
});
test('no-JavaScript fallback links use the same isolated draft stores', () => {
  for (const [kind, file] of Object.entries({join: 'join/index.html', contact: 'contact/index.html'})) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const links = Array.from(html.matchAll(/(?:href|src)="(https:\/\/forms\.yandex\.ru\/u\/6aacf2a849af472ed76c9d3d[^\"]*)"/g));
    assert.ok(links.length > 0, file);
    for (const [, href] of links) {
      const url = new URL(href.replaceAll('&amp;', '&'));
      assert.equal(url.searchParams.get('form:cache_key'), new URL(pairs()[kind][0]).searchParams.get('form:cache_key'), file);
      assert.equal(url.searchParams.has('answer_boolean_9008988974137832'), false, 'consent stays manual');
    }
  }
});
