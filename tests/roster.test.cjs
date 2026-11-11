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
const elena = 'Елена Никитина';
const profile = 'https://russialoppet.ru/athletes/182505/';

function sectionNames(id) {
  const section = team.match(new RegExp('<section\\b[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)</section>'));
  assert.ok(section, 'Team page section must exist: ' + id);
  return Array.from(section[1].matchAll(/<h3\b[^>]*>([^<]+)<\/h3>/g), match => match[1].trim());
}

test('roster has 15 main and 15 expanded athletes, with no duplicate members', () => {
  assert.equal(ROSTER.length, 15);
  assert.equal(reserve.length, 15);
  assert.equal(ALL_MEMBERS.length, 30);
  assert.equal(new Set(names(ALL_MEMBERS)).size, 30);
  assert.deepEqual(names(ALL_MEMBERS), [...names(ROSTER), ...names(reserve)]);
  assert.ok(names(ROSTER).includes(lyudmila));
  assert.ok(!names(ROSTER).includes(polina));
  assert.ok(names(reserve).includes(polina));
  assert.ok(!names(reserve).includes(lyudmila));
  assert.ok(names(reserve).includes(elena));
  const z = reserve.find(member => member.name === "Семен Замятин");
  assert.equal(z.city, "Петрозаводск");
  assert.equal(z.rl, "https://russialoppet.ru/athletes/25744/");
  assert.equal(ATHLETE_PROFILE_LINKS[z.name], z.rl);
  assert.ok(fs.existsSync(path.join(root, z.photo)));
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

test('updated athletes have one statistics record and one results record', () => {
  for (const name of [lyudmila, polina, elena, "Семен Замятин", "Сергей Прокопьев"]) {
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
  assert.equal(members.length, 30);
  assert.equal(new Set(members).size, 30);
  assert.deepEqual(members.sort(), names(ALL_MEMBERS).sort());
});

test('displayed tier counts agree with the new roster', () => {
  const notes = Array.from(html.matchAll(/<div class="roster-tier-note">([^<]+)<\/div>/g), match => match[1]);
  assert.equal(notes.filter(note => note.startsWith('15 спортсменов')).length, 5);
  assert.ok(!notes.some(note => /^(11|12|13) спортсменов/.test(note)));
});


test('Sergey Prokopyev has the verified RL profile, results and crop-safe portrait', () => {
  const name = 'Сергей Прокопьев';
  const member = reserve.find(member => member.name === name);
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'data/russialoppet-sergey-prokopyev-2026-11-11.json'), 'utf8'));
  const stats = WOLF_STATS.find(record => record.name === name);
  const latest = RESULTS.find(record => record.athlete === name);
  assert.equal(member.city, snapshot.city);
  assert.equal(member.rl, snapshot.profile);
  assert.equal(ATHLETE_PROFILE_LINKS[name], snapshot.profile);
  assert.ok(fs.statSync(path.join(root, member.photo)).size > 0);
  assert.equal(stats.total, snapshot.marathons);
  assert.equal(stats.skate + stats.classic, snapshot.marathons);
  assert.equal(stats.classic, 2);
  assert.equal(stats.fastest, snapshot.confirmed50km.time);
  assert.equal(stats.seasonMax, 4);
  assert.equal(latest.time, snapshot.latestMarathon.time);
  assert.equal(latest.absPlace, snapshot.latestMarathon.absPlace);
  assert.equal(latest.groupPlace, snapshot.latestMarathon.groupPlace);
  assert.ok(team.includes('id="sergey-prokopyev"'));
});
