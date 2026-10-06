import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preflight } from '../preflight.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'vargi-preflight-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repositoryRoot = path.join(temporary, 'repo');
  const DATA_PATH = path.join(temporary, 'data');
  const PRIVATE_TMP_PATH = path.join(temporary, 'tmp');
  const PRIVATE_ENV_FILE = path.join(temporary, 'api.env');
  await mkdir(repositoryRoot);
  await mkdir(DATA_PATH, { mode: 0o700 });
  await mkdir(PRIVATE_TMP_PATH, { mode: 0o700 });
  await writeFile(PRIVATE_ENV_FILE, `ADMIN_SESSION_SECRET=${'x'.repeat(48)}\n`, { mode: 0o600 });
  return {
    env: { SITE_HOST: 'stage.example.net', SITE_ORIGIN: 'https://stage.example.net', DATA_PATH, PRIVATE_ENV_FILE, PRIVATE_TMP_PATH },
    options: { repositoryRoot, dataUid: process.getuid() }
  };
}

test('safe staging defaults pass without production credentials', async t => {
  const f = await fixture(t);
  assert.deepEqual(await preflight(f.env, f.options), { siteHost: 'stage.example.net', readOnly: true, maintenanceDisabled: true });
});

test('preflight refuses public credentials, secrets in checkout, and an absent session secret', async t => {
  const f = await fixture(t);
  await chmod(f.env.PRIVATE_ENV_FILE, 0o644);
  await assert.rejects(preflight(f.env, f.options), /group\/others/);
  await chmod(f.env.PRIVATE_ENV_FILE, 0o600);
  await writeFile(f.env.PRIVATE_ENV_FILE, 'ADMIN_SESSION_SECRET=[токен скрыт]\n');
  await assert.rejects(preflight(f.env, f.options), /32 characters/);
  const inside = path.join(f.options.repositoryRoot, 'api.env');
  await writeFile(inside, `ADMIN_SESSION_SECRET=${'x'.repeat(48)}\n`, { mode: 0o600 });
  await assert.rejects(preflight({ ...f.env, PRIVATE_ENV_FILE: inside }, f.options), /outside the checkout/);
});

test('staging refuses notifications, backups and destructive maintenance', async t => {
  const f = await fixture(t);
  await writeFile(f.env.PRIVATE_ENV_FILE, `ADMIN_SESSION_SECRET=${'x'.repeat(48)}\nTELEGRAM_BOT_TOKEN=production-token\n`);
  await assert.rejects(preflight(f.env, f.options), /production setup/);
  await writeFile(f.env.PRIVATE_ENV_FILE, `ADMIN_SESSION_SECRET=${'x'.repeat(48)}\n`);
  await assert.rejects(preflight({ ...f.env, AUTO_MAINTENANCE_DISABLED: '0' }, f.options), /AUTO_MAINTENANCE_DISABLED=1/);
});

test('public host and origin cannot disagree or downgrade HTTPS', async t => {
  const f = await fixture(t);
  await assert.rejects(preflight({ ...f.env, SITE_ORIGIN: 'http://stage.example.net' }, f.options), /https/);
  await assert.rejects(preflight({ ...f.env, SITE_HOST: 'https://stage.example.net' }, f.options), /hostname/);
});

test('invalid DNS labels and literal IP addresses fail before TLS configuration', async t => {
  const f = await fixture(t);
  for (const SITE_HOST of ['a.-b.net', 'a.b-.net', `${'a'.repeat(64)}.net`, '127.0.0.1', 'stage..net']) {
    await assert.rejects(preflight({ ...f.env, SITE_HOST, SITE_ORIGIN: `https://${SITE_HOST}` }, f.options), /hostname/);
  }
});

test('backup temporary storage is mandatory, private, owned by the API user and outside the checkout', async t => {
  const f = await fixture(t);
  await assert.rejects(preflight({ ...f.env, PRIVATE_TMP_PATH: undefined }, f.options), /PRIVATE_TMP_PATH.*absolute/);
  await chmod(f.env.PRIVATE_TMP_PATH, 0o755);
  await assert.rejects(preflight(f.env, f.options), /PRIVATE_TMP_PATH.*group\/others/);
  await chmod(f.env.PRIVATE_TMP_PATH, 0o700);
  await assert.rejects(preflight(f.env, { ...f.options, dataUid: process.getuid() + 1 }), /owned by UID 1000/);
  const inside = path.join(f.options.repositoryRoot, 'private-tmp');
  await mkdir(inside, { mode: 0o700 });
  await assert.rejects(preflight({ ...f.env, PRIVATE_TMP_PATH: inside }, f.options), /PRIVATE_TMP_PATH.*outside the checkout/);
});

test('temporary archives cannot overlap data or the private credential file in either direction', async t => {
  const f = await fixture(t);
  await assert.rejects(preflight({ ...f.env, PRIVATE_TMP_PATH: f.env.DATA_PATH }, f.options), /DATA_PATH and PRIVATE_TMP_PATH.*non-overlapping/);
  const nested = path.join(f.env.DATA_PATH, 'tmp');
  await mkdir(nested, { mode: 0o700 });
  await assert.rejects(preflight({ ...f.env, PRIVATE_TMP_PATH: nested }, f.options), /DATA_PATH and PRIVATE_TMP_PATH.*non-overlapping/);
  const nestedData = path.join(f.env.PRIVATE_TMP_PATH, 'data');
  await mkdir(nestedData, { mode: 0o700 });
  await assert.rejects(preflight({ ...f.env, DATA_PATH: nestedData }, f.options), /DATA_PATH and PRIVATE_TMP_PATH.*non-overlapping/);
  const nestedEnv = path.join(f.env.PRIVATE_TMP_PATH, 'private.env');
  await writeFile(nestedEnv, `ADMIN_SESSION_SECRET=${'x'.repeat(48)}\n`, { mode: 0o600 });
  await assert.rejects(preflight({ ...f.env, PRIVATE_ENV_FILE: nestedEnv }, f.options), /PRIVATE_ENV_FILE and PRIVATE_TMP_PATH.*non-overlapping/);
});
