import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildStatic } from '../build-static.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'vargi-public-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  await mkdir(source);
  const put = async (name, content = 'fixture') => {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), content);
  };
  for (const name of ['index.html', 'assets/board-connection.js']) await put(name);
  for (const name of ['board/index.html', 'board/admin/index.html', 'board/submit/index.html']) {
    await put(name, '<script src="/assets/board-runtime.js"></script><script src="/assets/board-connection.js"></script>');
  }
  return { source, output: path.join(temporary, 'site'), put, temporary };
}

async function walk(root, relative = '') {
  const paths = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(root, name)); else paths.push(name);
  }
  return paths.sort();
}

test('only website files are published; private trees and nested operational files are excluded', async t => {
  const f = await fixture(t);
  for (const name of ['assets/pack/wolf.jpg', 'nutrition/certificates/diploma.pdf', 'data/races.json', 'shop/order/index.html', 'robots.txt']) await f.put(name);
  for (const name of ['.git/config', '.env', 'market-api/server.js', '.github/workflows/test.yml', 'scripts/export.js', 'cloudflare/worker.js', 'deploy/private.txt', 'tests/index.html', 'tools/index.html', 'docs/report.txt', 'assets/.env', 'assets/admin-auth.json', 'data/submissions/customer.json', 'data/telegram-notify.json', 'assets/backup.tar.gz', 'assets/private.pem']) await f.put(name, 'must-never-be-served');
  await buildStatic(f);
  const files = await walk(f.output);
  assert.deepEqual(files, [
    'assets/board-connection.js', 'assets/board-runtime.js', 'assets/pack/wolf.jpg',
    'board/admin/index.html', 'board/index.html', 'board/submit/index.html',
    'data/races.json', 'index.html', 'nutrition/certificates/diploma.pdf',
    'robots.txt', 'shop/order/index.html'
  ]);
});

test('same-origin runtime replaces only the built copy and keeps the source default unchanged', async t => {
  const f = await fixture(t);
  const original = "window.VARGI_MARKET_CONFIG={mode:'legacy'};";
  await f.put('assets/board-runtime.js', original);
  await buildStatic(f);
  assert.match(await readFile(path.join(f.output, 'assets/board-runtime.js'), 'utf8'), /mode: 'same-origin'/);
  assert.equal(await readFile(path.join(f.source, 'assets/board-runtime.js'), 'utf8'), original);
});

test('a symlink inside a public tree aborts the build instead of exporting an external file', async t => {
  const f = await fixture(t);
  const privateFile = path.join(f.temporary, 'private.json');
  await writeFile(privateFile, 'private');
  await symlink(privateFile, path.join(f.source, 'assets/outside.json'));
  await assert.rejects(buildStatic(f), /symbolic link/);
  await assert.rejects(readFile(path.join(f.output, 'index.html')), { code: 'ENOENT' });
});

test('missing main page or runtime integration cannot produce a deployable image', async t => {
  const f = await fixture(t);
  await rm(path.join(f.source, 'index.html'));
  await assert.rejects(buildStatic(f), { code: 'ENOENT' });
  await f.put('index.html');
  await f.put('board/index.html', '<html>old board without runtime</html>');
  await assert.rejects(buildStatic(f), /runtime is not included/);
});

test('build never overwrites an existing destination or writes into the checkout', async t => {
  const f = await fixture(t);
  await assert.rejects(buildStatic({ source: f.source, output: path.join(f.source, 'public') }), /outside the source/);
  await mkdir(f.output);
  await writeFile(path.join(f.output, 'keep.txt'), 'existing');
  await assert.rejects(buildStatic(f), /already exists/);
  assert.equal(await readFile(path.join(f.output, 'keep.txt'), 'utf8'), 'existing');
});
