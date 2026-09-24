import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { mkdir, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import path from 'node:path';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3000);
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://xn----7sbbfg4a6clj5k.xn--p1ai';
const DATA_ROOT = process.env.DATA_ROOT || '/data';
const DATA_DIR = process.env.SUBMISSIONS_DIR || path.join(DATA_ROOT, 'submissions');
const AUTH_FILE = path.join(DATA_ROOT, 'admin-auth.json');
const ADMIN_SETUP_TOKEN = process.env.ADMIN_SETUP_TOKEN || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || '';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

await mkdir(DATA_DIR, { recursive: true });

app.use(cors({
  origin(origin, cb) {
    if (!origin || origin === SITE_ORIGIN) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 6,
    fileSize: 2.5 * 1024 * 1024,
    fieldSize: 100 * 1024,
    fields: 50
  },
  fileFilter(req, file, cb) {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    cb(allowed.has(file.mimetype) ? null : new Error('Недопустимый тип файла'), allowed.has(file.mimetype));
  }
});

function clean(value, max = 4000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function isImageSignature(buffer, mime) {
  if (!buffer || buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (mime === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function extensionFor(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
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
  if (item.categoryKey) return item.categoryKey;
  const map = {
    'Лыжи': 'skis',
    'Ботинки и крепления': 'boots',
    'Палки': 'poles',
    'Лыжероллеры': 'rollers',
    'Одежда и аксессуары': 'clothes'
  };
  return map[item.category] || 'clothes';
}

function publicListing(item, req) {
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
    contact: item.contact,
    contactName: item.contactName || '',
    publicContact: item.publicContact || '',
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
    description: item.description || item.message || '',
    photos: (item.photos || []).map(photo => ({
      filename: photo.filename,
      url: base + '/listings/' + encodeURIComponent(item.id) + '/photos/' + encodeURIComponent(photo.filename)
    }))
  };
}

function h(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

app.get('/market', async (req, res) => {
  try {
    const items = (await listSubmissions()).filter(item => item.status === 'published');
    const cards = items.map(item => {
      const first = item.photos?.[0];
      const photo = first ? '<img src="/listings/' + encodeURIComponent(item.id) + '/photos/' + encodeURIComponent(first.filename) + '" alt="" style="width:180px;height:140px;object-fit:cover;border-radius:8px">' : '';
      return '<article style="border:1px solid #263d4a;border-radius:12px;padding:14px;background:#10161b">' +
        photo + '<h2>' + h(item.title) + '</h2><p>' + h(item.city) + '</p><p><b>' + h(item.price || '') + '</b></p>' +
        '<p>' + h(item.description || '') + '</p><p>Контакт: ' + h(item.contact || '') + '</p></article>';
    }).join('');
    res.type('html').send('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Северный маркет ВАРГИ</title></head><body style="margin:0;background:#07080a;color:#edf3f7;font:14px Arial"><main style="max-width:1100px;margin:auto;padding:24px"><p><a style="color:#8fd0ef" href="' + SITE_ORIGIN + '/">← ВАРГИ</a></p><h1>Северный маркет</h1><p><a style="color:#8fd0ef" href="' + SITE_ORIGIN + '/board/submit/">+ Подать объявление</a></p><section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">' + (cards || '<p>Объявлений пока нет.</p>') + '</section></main></body></html>');
  } catch (error) {
    res.status(500).send('Не удалось загрузить объявления');
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
    res.json({ ok: true, listings: items.map(item => publicListing(item, req)) });
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
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > 9 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'Суммарный размер фотографий слишком большой.' });
    }
    for (const file of files) {
      if (!isImageSignature(file.buffer, file.mimetype)) {
        return res.status(400).json({ ok: false, error: 'Один из файлов не является корректным изображением.' });
      }
    }

    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
    submissionDir = path.join(DATA_DIR, id);
    await mkdir(submissionDir, { recursive: false });

    const savedPhotos = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const filename = `photo-${String(i + 1).padStart(2, '0')}${extensionFor(file.mimetype)}`;
      await writeFile(path.join(submissionDir, filename), file.buffer, { flag: 'wx' });
      savedPhotos.push({
        filename,
        originalName: clean(file.originalname, 180),
        mimeType: file.mimetype,
        size: file.size
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
    res.status(500).json({ ok: false, error: 'Не удалось сохранить заявку. Попробуйте ещё раз.' });
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
