import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { mkdir, writeFile, readFile, readdir, rm, rename, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as tar from 'tar';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req,res,next)=>{
  res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','strict-origin-when-cross-origin');
  res.set('X-Frame-Options','DENY');
  res.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(req.secure || req.get('x-forwarded-proto')==='https') res.set('Strict-Transport-Security','max-age=15552000');
  next();
});

const PORT = Number(process.env.PORT || 3000);
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://xn----7sbbfg4a6clj5k.xn--p1ai';
const DATA_ROOT = process.env.DATA_ROOT || '/data';
const DATA_DIR = process.env.SUBMISSIONS_DIR || path.join(DATA_ROOT, 'submissions');
const AUTH_FILE = path.join(DATA_ROOT, 'admin-auth.json');
const ADMIN_SETUP_TOKEN = process.env.ADMIN_SETUP_TOKEN || '';
const ADMIN_RECOVERY_TOKEN = process.env.ADMIN_RECOVERY_TOKEN || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || '';
const BACKUP_S3_ENDPOINT = process.env.BACKUP_S3_ENDPOINT || '';
const BACKUP_S3_REGION = process.env.BACKUP_S3_REGION || '';
const BACKUP_S3_BUCKET = process.env.BACKUP_S3_BUCKET || '';
const BACKUP_S3_ACCESS_KEY_ID = process.env.BACKUP_S3_ACCESS_KEY_ID || '';
const BACKUP_S3_SECRET_ACCESS_KEY = process.env.BACKUP_S3_SECRET_ACCESS_KEY || '';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BACKUP_MARKER = path.join(DATA_ROOT, '.last-backup-date');

await mkdir(DATA_DIR, { recursive: true });

app.use(cors({
  origin(origin, cb) {
    if (!origin || origin === SITE_ORIGIN) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '32kb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Слишком много заявок. Попробуйте позже.' }
});
app.use('/submit', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Слишком много попыток. Попробуйте позже.' }
});
app.use('/admin/login', authLimiter);
app.use('/admin/setup', authLimiter);
app.use('/admin/recover', authLimiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 6,
    fileSize: 8 * 1024 * 1024,
    fieldSize: 100 * 1024,
    fields: 50
  },
  fileFilter(req, file, cb) {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
    cb(allowed.has(file.mimetype) ? null : new Error('Недопустимый тип файла'), allowed.has(file.mimetype));
  }
});

function clean(value, max = 4000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function isHeicSignature(buffer) {
  if (!buffer || buffer.length < 12) return false;
  const brand = buffer.toString('ascii', 8, 12).toLowerCase();
  return buffer.toString('ascii', 4, 8) === 'ftyp' && ['heic','heix','hevc','hevx','mif1','msf1'].includes(brand);
}

function isImageSignature(buffer, mime) {
  if (!buffer || buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (mime === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'image/heic' || mime === 'image/heif') return isHeicSignature(buffer);
  return false;
}

async function normalizeImage(file) {
  let input = file.buffer;
  if (file.mimetype === 'image/heic' || file.mimetype === 'image/heif') {
    input = Buffer.from(await heicConvert({ buffer: file.buffer, format: 'JPEG', quality: 0.82 }));
  }
  return sharp(input, { failOn: 'warning' })
    .rotate()
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

function validId(id) {
  return /^[0-9TZ_-]{20,80}_[a-f0-9]{8}$/.test(String(id || ''));
}

function submissionPath(id) {
  if (!validId(id)) throw new Error('invalid_submission_id');
  return path.join(DATA_DIR, id);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + randomUUID().slice(0, 8);
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

async function loadSubmission(id) {
  return readJson(path.join(submissionPath(id), 'submission.json'));
}

async function fileExists(file) {
  try { await access(file); return true; } catch { return false; }
}

function backupClient() {
  if (!BACKUP_S3_ENDPOINT || !BACKUP_S3_REGION || !BACKUP_S3_BUCKET || !BACKUP_S3_ACCESS_KEY_ID || !BACKUP_S3_SECRET_ACCESS_KEY) return null;
  return new S3Client({
    endpoint: BACKUP_S3_ENDPOINT,
    region: BACKUP_S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: BACKUP_S3_ACCESS_KEY_ID,
      secretAccessKey: BACKUP_S3_SECRET_ACCESS_KEY
    }
  });
}

let backupRunning = false;
async function createVolumeBackup(force = false) {
  const client = backupClient();
  if (!client || backupRunning) return { ok: false, skipped: true, reason: client ? 'busy' : 'not_configured' };
  const today = new Date().toISOString().slice(0, 10);
  if (!force) {
    try {
      const last = (await readFile(BACKUP_MARKER, 'utf8')).trim();
      if (last === today) return { ok: true, skipped: true, reason: 'already_today' };
    } catch {}
  }

  backupRunning = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join('/tmp', 'vargi-market-' + stamp + '.tgz');
  try {
    const entries = ['submissions'];
    if (await fileExists(AUTH_FILE)) entries.push('admin-auth.json');
    await tar.c({ gzip: true, cwd: DATA_ROOT, file: tmp }, entries);
    const key = 'daily/' + stamp + '.tgz';
    const uploader = new Upload({
      client,
      params: {
        Bucket: BACKUP_S3_BUCKET,
        Key: key,
        Body: createReadStream(tmp),
        ContentType: 'application/gzip'
      }
    });
    await uploader.done();
    await writeFile(BACKUP_MARKER, today, 'utf8');

    const listed = await client.send(new ListObjectsV2Command({ Bucket: BACKUP_S3_BUCKET, Prefix: 'daily/' }));
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const old = (listed.Contents || []).filter(obj => obj.Key && obj.LastModified && obj.LastModified.getTime() < cutoff);
    if (old.length) {
      await client.send(new DeleteObjectsCommand({
        Bucket: BACKUP_S3_BUCKET,
        Delete: { Objects: old.map(obj => ({ Key: obj.Key })), Quiet: true }
      }));
    }

    console.log('backup_saved key=' + key);
    return { ok: true, key };
  } catch (error) {
    console.error('backup_error', error?.message || error);
    return { ok: false, error: 'backup_failed' };
  } finally {
    backupRunning = false;
    try { await rm(tmp, { force: true }); } catch {}
  }
}

async function purgeExpiredTrash() {
  const items = await listSubmissions();
  const expired = items.filter(item =>
    item.status === 'trash' &&
    item.deletedAt &&
    Date.now() - new Date(item.deletedAt).getTime() >= TRASH_RETENTION_MS
  );
  if (!expired.length) return 0;
  if (backupClient()) await createVolumeBackup(true);
  for (const item of expired) {
    try { await rm(submissionPath(item.id), { recursive: true, force: true }); }
    catch (error) { console.error('trash_purge_error', item.id, error?.message || error); }
  }
  if (expired.length) console.log('trash_purged count=' + expired.length);
  return expired.length;
}

async function runMaintenance() {
  try { await createVolumeBackup(false); } catch {}
  try { await purgeExpiredTrash(); } catch (error) { console.error('maintenance_error', error?.message || error); }
}

async function listSubmissions() {
  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    try {
      items.push(await loadSubmission(entry.name));
    } catch (error) {
      console.error('submission_read_error', entry.name, error?.message || error);
    }
  }
  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return items;
}

async function authState() {
  try {
    return await readJson(AUTH_FILE);
  } catch {
    return null;
  }
}

function safeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function hashPassword(password, salt = randomBytes(16)) {
  const hash = scryptSync(password, salt, 64);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function verifyPassword(password, auth) {
  try {
    const salt = Buffer.from(auth.salt, 'base64');
    const expected = Buffer.from(auth.hash, 'base64');
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signSession() {
  if (!ADMIN_SESSION_SECRET) throw new Error('admin_session_secret_missing');
  const payload = b64url(JSON.stringify({
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    nonce: randomBytes(8).toString('hex')
  }));
  const signature = createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function verifySession(token) {
  try {
    if (!ADMIN_SESSION_SECRET || !token) return false;
    const [payload, signature] = String(token).split('.');
    if (!payload || !signature) return false;
    const expected = createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
    if (!safeEqualText(signature, expected)) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifySession(token)) return res.status(401).json({ ok: false, error: 'Требуется вход администратора.' });
  next();
}

function publicBase(req) {
  return req.protocol + '://' + req.get('host');
}

function categoryKeyFor(item) {
  const map = {
    skis: 'skis',
    boots: 'boots',
    poles: 'poles',
    rollers: 'rollers',
    clothes: 'clothes',
    'Лыжи': 'skis',
    'Ботинки и крепления': 'boots',
    'Палки': 'poles',
    'Лыжероллеры': 'rollers',
    'Одежда и аксессуары': 'clothes'
  };
  return map[item.categoryKey] || map[item.category] || 'clothes';
}

function listingDescription(item) {
  if (item.description) return item.description;
  const message = String(item.message || '');
  const match = message.match(/(?:^|\r?\n)Описание:\s*([\s\S]*?)(?:\r?\n\r?\nКонтакт:|$)/i);
  return match ? match[1].trim() : '';
}

function publicListing(item, req, includeContact = true) {
  const base = publicBase(req);
  return {
    id: item.id,
    date: item.publishedAt || item.createdAt,
    createdAt: item.createdAt,
    publishedAt: item.publishedAt || null,
    kind: 'sell',
    category: categoryKeyFor(item),
    title: item.title,
    city: item.city,
    price: Number.isFinite(Number(item.priceValue)) ? Number(item.priceValue) : Number(String(item.price || '').replace(/[^0-9]/g, '')) || null,
    ...(includeContact ? {
      contact: item.contact,
      contactName: item.contactName || '',
      publicContact: item.publicContact || ''
    } : {}),
    condition: item.condition || '',
    brand: item.brand || '',
    model: item.model || '',
    delivery: item.delivery || '',
    style: item.style || '',
    length: item.length || '',
    structureKind: item.structureKind || 'unknown',
    structureValue: item.structureValue || '',
    flex: item.flex || '',
    weight: item.weight || '',
    bindings: item.bindings || '',
    otherSpec: item.otherSpec || '',
    description: listingDescription(item),
    photos: (item.photos || []).map(photo => ({
      filename: photo.filename,
      url: base + '/listings/' + encodeURIComponent(item.id) + '/photos/' + encodeURIComponent(photo.filename)
    }))
  };
}

function h(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

const MARKET_CATEGORIES = {
  skis: 'Лыжи',
  boots: 'Ботинки и крепления',
  poles: 'Палки',
  rollers: 'Лыжероллеры',
  clothes: 'Одежда и аксессуары'
};

function marketMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('ru-RU').format(n) + ' ₽' : 'Цена по запросу';
}

function marketPage(title, body) {
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + h(title) + ' — Северный маркет ВАРГИ</title>' +
    '<meta name="robots" content="noindex,follow"><meta name="theme-color" content="#07080a">' +
    '<style>' +
    ':root{color-scheme:dark;--bg:#07080a;--panel:#10161b;--panel2:#0b1116;--line:#263d4a;--ink:#edf3f7;--muted:#9fb0bc;--ice:#8fd0ef;--accent:#3e9bd6}' +
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 Arial,system-ui,sans-serif}a{color:inherit}.wrap{width:min(1180px,calc(100% - 32px));margin:auto}' +
    '.header{border-bottom:1px solid var(--line);background:#07080a}.header-row{min-height:70px;display:flex;align-items:center;gap:18px}.brand{font-size:21px;font-weight:800;letter-spacing:.14em;text-decoration:none}.brand b{color:var(--accent)}.header-title{color:var(--muted)}.header-actions{margin-left:auto;display:flex;gap:10px;align-items:center}' +
    '.button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 15px;border:1px solid var(--ice);border-radius:8px;background:var(--ice);color:#07131b;text-decoration:none;font-weight:700}.button.secondary{background:transparent;color:var(--ice);border-color:var(--line)}' +
    '.hero{padding:34px 0 18px}.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--ice);font-weight:700}.hero h1{font-size:clamp(34px,5vw,54px);line-height:1.04;margin:8px 0 12px;letter-spacing:-.035em}.hero p{max-width:720px;color:var(--muted);margin:0}' +
    '.filters{display:grid;grid-template-columns:2fr 1fr 1fr 130px 130px 160px auto;gap:9px;margin:24px 0 22px}.filters input,.filters select{width:100%;min-height:44px;border:1px solid var(--line);border-radius:8px;background:#080e13;color:var(--ink);padding:10px 11px}.filters button{cursor:pointer}' +
    '.catalog-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}.counter{font-size:12px;color:var(--muted)}' +
    '.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding-bottom:42px}.card{display:flex;flex-direction:column;min-width:0;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--panel);text-decoration:none;transition:border-color .18s,transform .18s}.card:hover{border-color:#5d7e92;transform:translateY(-2px)}' +
    '.photo{height:220px;background:radial-gradient(circle at 50% 42%,#1a3342,#090f13 72%);display:flex;align-items:center;justify-content:center;overflow:hidden;color:#7694a6}.photo img{width:100%;height:100%;object-fit:cover}.photo-empty{font-size:12px;letter-spacing:.12em;text-transform:uppercase}' +
    '.card-body{padding:16px;display:flex;flex-direction:column;gap:9px;flex:1}.kind{font-size:10px;color:var(--ice);text-transform:uppercase;letter-spacing:.12em}.title{font-size:19px;font-weight:700;line-height:1.25}.meta{font-size:12px;color:var(--muted)}.desc{font-size:13px;color:#c4d0d8;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.price{font-size:25px;font-weight:800;letter-spacing:-.03em;margin-top:auto;padding-top:5px}.more{color:var(--ice);font-size:12px;margin-top:2px}' +
    '.empty{padding:64px 24px;text-align:center;border:1px dashed var(--line);border-radius:14px;color:var(--muted)}' +
    '.detail-wrap{padding:26px 0 42px}.back{display:inline-block;color:var(--ice);text-decoration:none;margin-bottom:18px}.detail{border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden}.detail-top{display:grid;grid-template-columns:1.15fr 1fr}.detail-hero{min-height:420px;background:#0a1116}.detail-hero img{width:100%;height:100%;max-height:520px;object-fit:contain}.detail-copy{padding:26px}.detail-copy h1{font-size:34px;line-height:1.1;margin:8px 0 10px}.detail-price{font-size:31px;font-weight:800;margin:18px 0}.gallery{display:flex;gap:8px;overflow:auto;padding:14px;border-top:1px solid var(--line)}.gallery img{width:130px;height:100px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}.detail-body{padding:0 26px 26px}.specs{display:grid;grid-template-columns:1fr 1fr;gap:0 22px;margin:10px 0 24px}.spec{padding:10px 0;border-bottom:1px solid var(--line)}.spec span{display:block;font-size:11px;color:var(--muted)}.description{white-space:pre-wrap;overflow-wrap:anywhere;color:#c7d2da}.contact{margin-top:20px;padding:14px;border:1px solid #42677b;border-radius:10px;background:#0a151c}' +
    '.footer{border-top:1px solid var(--line);padding:18px 0 26px;color:var(--muted);font-size:12px}' +
    '@media(max-width:980px){.filters{grid-template-columns:repeat(3,1fr)}.filters .wide{grid-column:1/-1}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.detail-top{grid-template-columns:1fr}}' +
    '@media(max-width:620px){.wrap{width:calc(100% - 20px)}.header-row{min-height:60px}.header-title,.header-actions .secondary{display:none}.button{padding:9px 11px}.hero{padding-top:24px}.filters{grid-template-columns:1fr}.filters .wide{grid-column:auto}.cards{grid-template-columns:1fr}.photo{height:240px}.detail-copy,.detail-body{padding:18px}.detail-copy h1{font-size:28px}.specs{grid-template-columns:1fr}.detail-hero{min-height:280px}}' +
    '</style></head><body>' +
    '<header class="header"><div class="wrap header-row"><a class="brand" href="' + h(SITE_ORIGIN) + '/" aria-label="ВАРГИ">В<b>А</b>Р<b>Г</b>И</a><span class="header-title">Северный маркет</span><div class="header-actions"><a class="button secondary" href="' + h(SITE_ORIGIN) + '/">На основной сайт</a><a class="button" href="' + h(SITE_ORIGIN) + '/board/submit/">+ Подать объявление</a></div></div></header>' +
    body +
    '<footer class="footer"><div class="wrap">ВАРГИ / Северный маркет · публикация только после модерации</div></footer></body></html>';
}

app.get('/', (req,res)=>res.redirect(302,'/market'));
app.get('/robots.txt', (req,res)=>{
  res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /submit\nAllow: /market\n');
});
app.get('/favicon.ico', (req,res)=>res.redirect(302, SITE_ORIGIN + '/assets/favicon.svg'));

app.get('/market', async (req, res) => {
  try {
    let items = (await listSubmissions())
      .filter(item => item.status === 'published')
      .map(item => publicListing(item, req));

    const q = clean(req.query.q, 120).toLocaleLowerCase('ru');
    const category = clean(req.query.category, 30);
    const city = clean(req.query.city, 80).toLocaleLowerCase('ru');
    const min = req.query.min === undefined || req.query.min === '' ? null : Number(req.query.min);
    const max = req.query.max === undefined || req.query.max === '' ? null : Number(req.query.max);
    const sort = clean(req.query.sort, 20) || 'newest';

    items = items.filter(item =>
      (!category || item.category === category) &&
      (!city || String(item.city || '').toLocaleLowerCase('ru').includes(city)) &&
      (!q || [item.title,item.brand,item.model,item.city,item.description,item.otherSpec,item.style,item.length,item.structureValue,item.structureKind,item.flex,item.weight,item.bindings].join(' ').toLocaleLowerCase('ru').includes(q)) &&
      (min === null || (item.price !== null && item.price >= min)) &&
      (max === null || (item.price !== null && item.price <= max))
    );

    items.sort((a,b) => sort === 'cheap'
      ? (a.price ?? Infinity) - (b.price ?? Infinity)
      : sort === 'expensive'
        ? (b.price ?? -Infinity) - (a.price ?? -Infinity)
        : String(b.date || '').localeCompare(String(a.date || ''))
    );

    const options = Object.entries(MARKET_CATEGORIES)
      .map(([key,label]) => '<option value="' + h(key) + '"' + (category === key ? ' selected' : '') + '>' + h(label) + '</option>')
      .join('');

    const cards = items.map(item => {
      const first = item.photos?.[0]?.url;
      const photo = first
        ? '<img src="' + h(first) + '" alt="Фото объявления">'
        : '<span class="photo-empty">Фото не добавлено</span>';
      const desc = clean(item.description, 180);
      return '<a class="card" href="/market/' + encodeURIComponent(item.id) + '">' +
        '<div class="photo">' + photo + '</div>' +
        '<div class="card-body"><div class="kind">' + h(MARKET_CATEGORIES[item.category] || item.category) + '</div>' +
        '<div class="title">' + h(item.title) + '</div>' +
        '<div class="meta">' + h(item.city) + (item.condition ? ' · ' + h(item.condition) : '') + '</div>' +
        (desc ? '<div class="desc">' + h(desc) + '</div>' : '') +
        '<div class="price">' + h(marketMoney(item.price)) + '</div><div class="more">Подробнее →</div></div></a>';
    }).join('');

    const body = '<main class="wrap"><section class="hero"><div class="eyebrow">Северный маркет</div><h1>Экипировка для следующего старта.</h1><p>Частные объявления о продаже лыж и экипировки. Публикация только после ручной модерации ВАРГИ.</p></section>' +
      '<form class="filters" method="get" action="/market">' +
      '<input class="wide" name="q" value="' + h(req.query.q || '') + '" placeholder="Лыжи, модель, размер, структура…">' +
      '<select name="category" onchange="this.form.submit()"><option value="">Все категории</option>' + options + '</select>' +
      '<input name="city" value="' + h(req.query.city || '') + '" placeholder="Город">' +
      '<input name="min" type="number" min="0" value="' + h(req.query.min || '') + '" placeholder="Цена от">' +
      '<input name="max" type="number" min="0" value="' + h(req.query.max || '') + '" placeholder="Цена до">' +
      '<select name="sort" onchange="this.form.submit()"><option value="newest"' + (sort === 'newest' ? ' selected' : '') + '>Сначала новые</option><option value="cheap"' + (sort === 'cheap' ? ' selected' : '') + '>Сначала дешевле</option><option value="expensive"' + (sort === 'expensive' ? ' selected' : '') + '>Сначала дороже</option></select>' +
      '<button class="button" type="submit">Найти</button></form>' +
      '<div class="catalog-head"><div class="counter">' + items.length + ' объявлений</div></div>' +
      (cards ? '<section class="cards">' + cards + '</section>' : '<div class="empty"><h2>Пока нет подходящих объявлений</h2><p>Измените фильтры или станьте первым продавцом в этом разделе.</p></div>') +
      '</main>';

    res.type('html').send(marketPage('Северный маркет', body));
  } catch (error) {
    console.error('market_page_error', error?.message || error);
    res.status(500).type('html').send(marketPage('Ошибка', '<main class="wrap"><div class="empty">Не удалось загрузить объявления.</div></main>'));
  }
});

app.get('/market/:id', async (req, res) => {
  try {
    const raw = await loadSubmission(req.params.id);
    if (raw.status !== 'published') return res.sendStatus(404);
    const item = publicListing(raw, req);
    const categoryLabel = MARKET_CATEGORIES[item.category] || item.category;

    const photos = item.photos || [];
    const heroPhoto = photos[0]?.url
      ? '<div class="detail-hero"><img src="' + h(photos[0].url) + '" alt="Фото объявления"></div>'
      : '<div class="detail-hero"></div>';

    const gallery = photos.length > 1
      ? '<div class="gallery">' + photos.slice(1).map(photo => '<img src="' + h(photo.url) + '" alt="Дополнительное фото">').join('') + '</div>'
      : '';

    const values = [
      ['Категория',categoryLabel],['Город',item.city],['Состояние',item.condition],
      ['Бренд / модель',[item.brand,item.model].filter(Boolean).join(' ')],['Передача',item.delivery],
      ['Стиль',item.style],['Длина',item.length ? String(item.length) + ' см' : ''],
      ['Структура',item.structureValue || item.structureKind],['Жёсткость / маркировка',item.flex],
      ['Вес по подбору',item.weight],['Крепления',item.bindings],['Характеристики',item.otherSpec]
    ].filter(pair => pair[1]);

    const specs = '<div class="specs">' + values.map(([key,value]) =>
      '<div class="spec"><span>' + h(key) + '</span><b>' + h(value) + '</b></div>'
    ).join('') + '</div>';

    const body = '<main class="wrap detail-wrap"><a class="back" href="/market">← К объявлениям</a>' +
      '<article class="detail"><div class="detail-top">' + heroPhoto +
      '<div class="detail-copy"><div class="eyebrow">' + h(categoryLabel) + '</div><h1>' + h(item.title) + '</h1>' +
      '<p class="meta">' + h(item.city) + (item.condition ? ' · ' + h(item.condition) : '') + '</p>' +
      '<div class="detail-price">' + h(marketMoney(item.price)) + '</div></div></div>' +
      gallery +
      '<div class="detail-body">' + specs + '<h2>Описание</h2><p class="description">' + h(item.description || '') + '</p>' +
      '<div class="contact"><b>Контакт продавца</b><br>' + h(item.contact || item.publicContact || 'Не указан') + '</div></div></article></main>';

    res.type('html').send(marketPage(item.title, body));
  } catch {
    res.sendStatus(404);
  }
});

app.get('/health', async (req, res) => {
  const auth = await authState();
  res.json({
    ok: true,
    service: 'vargi-market-api',
    storage: 'persistent-volume',
    adminInitialized: Boolean(auth)
  });
});

app.get('/listings', async (req, res) => {
  try {
    const items = (await listSubmissions()).filter(item => item.status === 'published');
    res.json({ ok: true, listings: items.map(item => publicListing(item, req, false)) });
  } catch (error) {
    console.error('listings_error', error?.message || error);
    res.status(500).json({ ok: false, error: 'Не удалось загрузить объявления.' });
  }
});

app.get('/listings/:id/photos/:filename', async (req, res) => {
  try {
    const item = await loadSubmission(req.params.id);
    if (item.status !== 'published') return res.sendStatus(404);
    const photo = (item.photos || []).find(p => p.filename === req.params.filename);
    if (!photo) return res.sendStatus(404);
    res.set('Cache-Control', 'public, max-age=3600');
    res.type(photo.mimeType || 'image/jpeg');
    res.sendFile(path.join(submissionPath(item.id), photo.filename));
  } catch {
    res.sendStatus(404);
  }
});

app.post('/submit', upload.array('photos', 6), async (req, res) => {
  let submissionDir = null;
  try {
    const honeypot = clean(req.body.website, 200);
    if (honeypot) return res.status(200).json({ ok: true });

    const title = clean(req.body.title, 120);
    const contact = clean(req.body.contact, 180);
    const message = clean(req.body.message, 8000);
    const category = clean(req.body.category, 80);
    const categoryKey = clean(req.body.categoryKey, 30);
    const city = clean(req.body.city, 100);
    const price = clean(req.body.price, 100);
    const priceValueRaw = Number(req.body.priceValue);

    if (title.length < 2 || contact.length < 4 || message.length < 20) {
      return res.status(400).json({ ok: false, error: 'Не хватает данных для отправки.' });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ ok: false, error: 'Добавьте хотя бы одну фотографию товара.' });
    }
    const inputBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (inputBytes > 24 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'Исходные фотографии слишком большие: максимум 24 МБ суммарно.' });
    }
    for (const file of files) {
      if (!isImageSignature(file.buffer, file.mimetype)) {
        return res.status(400).json({ ok: false, error: 'Один из файлов не является корректным JPEG, PNG, WebP или HEIC.' });
      }
    }

    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
    submissionDir = path.join(DATA_DIR, id);
    await mkdir(submissionDir, { recursive: false });

    const savedPhotos = [];
    let normalizedTotal = 0;
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const normalized = await normalizeImage(file);
      normalizedTotal += normalized.length;
      if (normalizedTotal > 9 * 1024 * 1024) {
        throw Object.assign(new Error('normalized_photos_too_large'), { statusCode: 413 });
      }
      const filename = `photo-${String(i + 1).padStart(2, '0')}.jpg`;
      await writeFile(path.join(submissionDir, filename), normalized, { flag: 'wx' });
      savedPhotos.push({
        filename,
        originalName: clean(file.originalname, 180),
        originalMimeType: file.mimetype,
        mimeType: 'image/jpeg',
        size: normalized.length
      });
    }

    const metadata = {
      id,
      status: 'pending',
      createdAt: new Date().toISOString(),
      kind: 'Продаю',
      category,
      categoryKey,
      title,
      city,
      price,
      priceValue: Number.isFinite(priceValueRaw) ? priceValueRaw : null,
      contact,
      contactName: clean(req.body.contactName, 80),
      publicContact: clean(req.body.publicContact, 140),
      condition: clean(req.body.condition, 80),
      brand: clean(req.body.brand, 80),
      model: clean(req.body.model, 100),
      delivery: clean(req.body.delivery, 100),
      style: clean(req.body.style, 50),
      length: clean(req.body.length, 30),
      structureKind: clean(req.body.structureKind, 30) || 'unknown',
      structureValue: clean(req.body.structureValue, 120),
      flex: clean(req.body.flex, 100),
      weight: clean(req.body.weight, 80),
      bindings: clean(req.body.bindings, 120),
      otherSpec: clean(req.body.otherSpec, 220),
      description: clean(req.body.description, 4000),
      message,
      photos: savedPhotos
    };

    await writeJsonAtomic(path.join(submissionDir, 'submission.json'), metadata);
    console.log(`submission_saved id=${id} photos=${savedPhotos.length}`);
    res.status(201).json({ ok: true, id });
  } catch (error) {
    console.error('submit_error', error?.message || error);
    if (submissionDir) {
      try { await rm(submissionDir, { recursive: true, force: true }); } catch (_) {}
    }
    const statusCode = Number(error?.statusCode) || 500;
    res.status(statusCode).json({ ok: false, error: statusCode === 413 ? 'Фотографии после обработки всё ещё слишком большие. Уменьшите количество или размер снимков.' : 'Не удалось сохранить заявку. Попробуйте ещё раз.' });
  }
});

app.get('/admin/status', async (req, res) => {
  res.json({ ok: true, initialized: Boolean(await authState()) });
});

app.post('/admin/setup', async (req, res) => {
  try {
    if (await authState()) return res.status(409).json({ ok: false, error: 'Администратор уже настроен.' });
    if (!ADMIN_SETUP_TOKEN || !ADMIN_SESSION_SECRET) return res.status(503).json({ ok: false, error: 'Настройка администратора недоступна.' });
    const setupToken = clean(req.body.setupToken, 200);
    const password = String(req.body.password || '');
    if (!safeEqualText(setupToken, ADMIN_SETUP_TOKEN)) return res.status(403).json({ ok: false, error: 'Неверный setup-ключ.' });
    if (password.length < 10 || password.length > 200) return res.status(400).json({ ok: false, error: 'Пароль должен содержать не менее 10 символов.' });
    const passwordData = hashPassword(password);
    await writeJsonAtomic(AUTH_FILE, {
      version: 1,
      createdAt: new Date().toISOString(),
      ...passwordData
    });
    res.status(201).json({ ok: true, token: signSession() });
  } catch (error) {
    console.error('admin_setup_error', error?.message || error);
    res.status(500).json({ ok: false, error: 'Не удалось создать администратора.' });
  }
});

app.post('/admin/login', async (req, res) => {
  try {
    const auth = await authState();
    if (!auth) return res.status(409).json({ ok: false, error: 'Администратор ещё не настроен.' });
    const password = String(req.body.password || '');
    if (!verifyPassword(password, auth)) return res.status(401).json({ ok: false, error: 'Неверный пароль.' });
    res.json({ ok: true, token: signSession() });
  } catch (error) {
    console.error('admin_login_error', error?.message || error);
    res.status(500).json({ ok: false, error: 'Не удалось выполнить вход.' });
  }
});

app.get('/admin/submissions', requireAdmin, async (req, res) => {
  try {
    const status = clean(req.query.status, 20) || 'pending';
    const allowed = new Set(['pending', 'published', 'rejected', 'all']);
    if (!allowed.has(status)) return res.status(400).json({ ok: false, error: 'Неизвестный статус.' });
    let items = await listSubmissions();
    if (status !== 'all') items = items.filter(item => item.status === status);
    res.json({ ok: true, submissions: items });
  } catch (error) {
    console.error('admin_list_error', error?.message || error);
    res.status(500).json({ ok: false, error: 'Не удалось загрузить заявки.' });
  }
});

app.get('/admin/submissions/:id/photos/:filename', requireAdmin, async (req, res) => {
  try {
    const item = await loadSubmission(req.params.id);
    const photo = (item.photos || []).find(p => p.filename === req.params.filename);
    if (!photo) return res.sendStatus(404);
    res.set('Cache-Control', 'no-store');
    res.type(photo.mimeType || 'image/jpeg');
    res.sendFile(path.join(submissionPath(item.id), photo.filename));
  } catch {
    res.sendStatus(404);
  }
});

async function changeStatus(req, res, status) {
  try {
    const item = await loadSubmission(req.params.id);
    item.status = status;
    item.updatedAt = new Date().toISOString();
    if (status === 'published') item.publishedAt = item.updatedAt;
    if (status === 'rejected') item.rejectedAt = item.updatedAt;
    await writeJsonAtomic(path.join(submissionPath(item.id), 'submission.json'), item);
    res.json({ ok: true, submission: item });
  } catch (error) {
    console.error('admin_status_error', error?.message || error);
    res.status(404).json({ ok: false, error: 'Заявка не найдена.' });
  }
}

app.post('/admin/submissions/:id/publish', requireAdmin, (req, res) => changeStatus(req, res, 'published'));
app.post('/admin/submissions/:id/reject', requireAdmin, (req, res) => changeStatus(req, res, 'rejected'));

app.delete('/admin/submissions/:id', requireAdmin, async (req, res) => {
  try {
    await rm(submissionPath(req.params.id), { recursive: true, force: false });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ ok: false, error: 'Заявка не найдена.' });
  }
});

app.use((error, req, res, next) => {
  console.error('request_error', error?.message || error);
  if (error?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, error: 'Одна из фотографий слишком большая.' });
  if (error?.code === 'LIMIT_FILE_COUNT') return res.status(413).json({ ok: false, error: 'Можно отправить не более 6 фотографий.' });
  res.status(400).json({ ok: false, error: 'Не удалось обработать запрос.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`vargi-market-api listening on ${PORT}; storage=${DATA_DIR}`);
});
