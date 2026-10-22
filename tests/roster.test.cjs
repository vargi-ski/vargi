const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const team = fs.readFileSync(path.join(root, 'team/index.html'), 'utf8');
const context = {window: {VARGI_IMAGES: {}}};
vm.createContext(context);
const start = html.indexOf('const ROSTER =');
const end = html.indexOf('const CALENDAR =', start);
assert.ok(start >= 0 && end > start, 'Roster data boundaries must exist.');
vm.runInContext(html.slice(start, end) + '\nthis.data = {ROSTER, RESERVE_ROSTER, ALL_MEMBERS, WOLF_STATS, ATHLETE_PROFILE_LINKS, RESULTS};', context);
const {ROSTER, RESERVE_ROSTER, ALL_MEMBERS, WOLF_STATS, ATHLETE_PROFILE_LINKS, RESULTS} = context.data;
const reserve = RESERVE_ROSTER.filter(member => !member.join);
const names = members => Array.from(members, member => member.name);
const lyudmila = 'Людмила Шамшина';
const polina = 'Полина Сероносова';
const profile = 'https://russialoppet.ru/athletes/182505/';

function sectionNames(id) {
  const section = team.match(new RegExp('<section\\b[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)</section>'));
  assert.ok(section, 'Team page section must exist: ' + id);
  return Array.from(section[1].matchAll(/<h3\b[^>]*>([^<]+)<\/h3>/g), match => match[1].trim());
}

test('roster has 15 main and 12 expanded athletes, with no duplicate members', () => {
  assert.equal(ROSTER.length, 15);
  assert.equal(reserve.length, 12);
  assert.equal(ALL_MEMBERS.length, 27);
  assert.equal(new Set(names(ALL_MEMBERS)).size, 27);
  assert.deepEqual(names(ALL_MEMBERS), [...names(ROSTER), ...names(reserve)]);
  assert.ok(names(ROSTER).includes(lyudmila));
  assert.ok(!names(ROSTER).includes(polina));
  assert.ok(names(reserve).includes(polina));
  assert.ok(!names(reserve).includes(lyudmila));
});

test('Lyudmila uses the supplied portrait asset and official RussiaLoppet profile', () => {
  const member = ROSTER.find(member => member.name === lyudmila);
  assert.equal(member.photo, 'assets/lyudmila-shamshina.webp');
  assert.ok(fs.statSync(path.join(root, member.photo)).size > 0, 'Portrait asset must be nonempty.');
  assert.equal(member.rl, profile);
  assert.equal(ATHLETE_PROFILE_LINKS[lyudmila], profile);
});

test('opening carousel shows Lyudmila instead of Polina', () => {
  const match = html.match(/const leftOpening\s*=\s*(\[[^;]+\]);/);
  assert.ok(match, 'Opening carousel order must be declared.');
  const opening = JSON.parse(match[1]);
  assert.ok(opening.includes(lyudmila));
  assert.ok(!opening.includes(polina));
  for (const name of opening) assert.ok(names(ROSTER).includes(name), name + ' must be in the main roster.');
});

test('both athletes retain one statistics record and one results record', () => {
  for (const name of [lyudmila, polina]) {
    assert.equal(WOLF_STATS.filter(record => record.name === name).length, 1, name + ': statistics record');
    assert.equal(RESULTS.filter(record => record.athlete === name).length, 1, name + ': results record');
  }
});

test('team page main and expanded membership matches the homepage', () => {
  assert.deepEqual(sectionNames('members'), names(ROSTER));
  assert.deepEqual(sectionNames('expanded'), names(reserve));
});

test('team structured data contains every athlete exactly once', () => {
  const scripts = Array.from(team.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g), match => JSON.parse(match[1]));
  const nodes = scripts.flatMap(document => document['@graph'] || [document]);
  const organization = nodes.find(node => node['@type'] === 'SportsOrganization');
  assert.ok(organization, 'SportsOrganization structured data must exist.');
  const members = names(organization.member);
  assert.equal(members.length, 27);
  assert.equal(new Set(members).size, 27);
  assert.deepEqual(members.sort(), names(ALL_MEMBERS).sort());
});

test('displayed tier counts agree with the new roster', () => {
  const notes = Array.from(html.matchAll(/<div class="roster-tier-note">([^<]+)<\/div>/g), match => match[1]);
  assert.equal(notes.filter(note => note.startsWith('15 спортсменов')).length, 3);
  assert.equal(notes.filter(note => note.startsWith('12 спортсменов')).length, 2);
  assert.ok(!notes.some(note => note.startsWith('11 спортсменов')));
});
