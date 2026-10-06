import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PRIVATE_KEYS = new Set([
  'ADMIN_SESSION_SECRET', 'ADMIN_SETUP_TOKEN', 'ADMIN_RECOVERY_TOKEN', 'TELEGRAM_BOT_TOKEN',
  'BACKUP_S3_ENDPOINT', 'BACKUP_S3_REGION', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID',
  'BACKUP_S3_SECRET_ACCESS_KEY'
]);

export async function preflight(env, { repositoryRoot = REPOSITORY_ROOT, dataUid = 1000 } = {}) {
  const siteHost = env.SITE_HOST || '';
  const validHostname = host => host.length <= 253 && host.includes('.') && !isIP(host) &&
    host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (!validHostname(siteHost)) {
    throw new Error('SITE_HOST must be one ASCII DNS hostname; use punycode for the Cyrillic domain');
  }
  if (env.SITE_ORIGIN !== `https://${siteHost}`) throw new Error('SITE_ORIGIN must exactly equal https://SITE_HOST');
  if (env.WWW_HOST && (env.WWW_HOST !== `www.${siteHost}` || !validHostname(env.WWW_HOST))) throw new Error('WWW_HOST must equal www.SITE_HOST and be a valid DNS hostname');
  for (const key of ['MIGRATION_READ_ONLY', 'AUTO_MAINTENANCE_DISABLED']) {
    if (env[key] && !['0', '1'].includes(env[key])) throw new Error(`${key} must be 0 or 1`);
  }
  const canonicalRepo = await realpath(repositoryRoot);
  const overlaps = (left, right) => left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
  const canonicalPaths = {};
  for (const key of ['PRIVATE_ENV_FILE', 'DATA_PATH', 'PRIVATE_TMP_PATH']) {
    if (!env[key] || !path.isAbsolute(env[key])) throw new Error(`${key} must be an absolute external path`);
    const stat = await lstat(env[key]);
    if (stat.isSymbolicLink()) throw new Error(`${key} must not be a symbolic link`);
    const canonical = await realpath(env[key]);
    if (overlaps(canonical, canonicalRepo)) throw new Error(`${key} must be outside the checkout and must not contain it`);
    canonicalPaths[key] = canonical;
    if (stat.mode & 0o077) throw new Error(`${key} must not be readable or writable by group/others`);
    if (key === 'PRIVATE_ENV_FILE' && !stat.isFile()) throw new Error('PRIVATE_ENV_FILE must be a regular file with mode 600');
    if (key !== 'PRIVATE_ENV_FILE' && (!stat.isDirectory() || stat.uid !== dataUid)) throw new Error(`${key} must be a directory owned by UID 1000 with mode 700`);
  }
  const keys = Object.keys(canonicalPaths);
  for (let left = 0; left < keys.length; left++) {
    for (let right = left + 1; right < keys.length; right++) {
      if (overlaps(canonicalPaths[keys[left]], canonicalPaths[keys[right]])) {
        throw new Error(`${keys[left]} and ${keys[right]} must be separate, non-overlapping private paths`);
      }
    }
  }
  const privateEnv = {};
  const lines = (await readFile(env.PRIVATE_ENV_FILE, 'utf8')).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !PRIVATE_KEYS.has(match[1]) || Object.hasOwn(privateEnv, match[1])) {
      throw new Error('Private env file has an unsupported/duplicate key or invalid raw KEY=value syntax');
    }
    privateEnv[match[1]] = match[2];
  }
  if (!privateEnv.ADMIN_SESSION_SECRET || privateEnv.ADMIN_SESSION_SECRET.length < 32 || /^\[.*\]$/.test(privateEnv.ADMIN_SESSION_SECRET)) {
    throw new Error('ADMIN_SESSION_SECRET must contain at least 32 characters; generate a fresh random value privately');
  }
  const readOnly = env.MIGRATION_READ_ONLY !== '0';
  const maintenanceDisabled = env.AUTO_MAINTENANCE_DISABLED !== '0';
  if (readOnly && !maintenanceDisabled) throw new Error('Read-only staging must have AUTO_MAINTENANCE_DISABLED=1');
  if (readOnly && Object.entries(privateEnv).some(([key, value]) => value && key !== 'ADMIN_SESSION_SECRET')) {
    throw new Error('Read-only staging must not receive production setup, notification or backup credentials');
  }
  return { siteHost, readOnly, maintenanceDisabled };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checked = await preflight(process.env);
  console.log(`Preflight OK: ${checked.siteHost}; readOnly=${checked.readOnly}; maintenanceDisabled=${checked.maintenanceDisabled}`);
}
