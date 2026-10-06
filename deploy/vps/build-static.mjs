import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only public website trees belong in the edge image. Never copy the repository
// root recursively: it also contains the API, tests, operations and credentials.
export const PUBLIC_DIRECTORIES = Object.freeze([
  'assets', 'data', 'ai-agent', 'analytics-dashboard', 'athletes', 'board',
  'camps', 'contact', 'group-training', 'lab', 'nutrition', 'shop', 'team', 'training-plan'
]);
export const PUBLIC_ROOT_FILES = Object.freeze([
  'index.html', 'robots.txt', 'sitemap.xml', 'privacy.html',
  'googlee90de7befe79cbfe.html', 'yandex_ffade7c35e6f2342.html',
  'd1beb41abda90599545afeb921a99493.txt'
]);
const REQUIRED_FILES = ['index.html', 'board/index.html', 'board/admin/index.html',
  'board/submit/index.html', 'assets/board-connection.js'];
const PUBLIC_EXTENSIONS = new Set([
  '.html', '.css', '.js', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp',
  '.gif', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.txt',
  '.xml', '.webmanifest', '.mp4', '.webm', '.ogg', '.mp3'
]);
const PRIVATE_NAMES = /^(?:admin-auth|telegram-notify|auth|backups?|submissions?|secrets?|credentials|node_modules|market-api|scripts|tests|deploy|cloudflare)(?:[._-]|$)/i;

export function isPublicFile(relative) {
  const parts = relative.split('/');
  if (parts.some(part => part.startsWith('.') || PRIVATE_NAMES.test(part))) return false;
  if (PUBLIC_ROOT_FILES.includes(relative)) return true;
  return PUBLIC_DIRECTORIES.includes(parts[0]) && PUBLIC_EXTENSIONS.has(path.posix.extname(relative).toLowerCase());
}

async function copyPublicTree(source, destination, relative, copied) {
  const item = await lstat(path.join(source, relative));
  if (item.isSymbolicLink()) throw new Error(`Public tree contains a symbolic link: ${relative}`);
  if (relative.split('/').some(part => part.startsWith('.') || PRIVATE_NAMES.test(part))) return;
  if (item.isDirectory()) {
    for (const entry of (await readdir(path.join(source, relative))).sort()) {
      await copyPublicTree(source, destination, path.posix.join(relative, entry), copied);
    }
  } else if (item.isFile() && isPublicFile(relative)) {
    await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
    await cp(path.join(source, relative), path.join(destination, relative), { dereference: false });
    copied.push(relative);
  }
}

export async function buildStatic({ source, output }) {
  const sourceRoot = path.resolve(source);
  const destination = path.resolve(output);
  if (destination === sourceRoot || destination.startsWith(sourceRoot + path.sep) || sourceRoot.startsWith(destination + path.sep)) {
    throw new Error('Output must be outside the source repository and must not contain it');
  }
  try {
    await lstat(destination);
    throw new Error('Output already exists; choose a new directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const relative of REQUIRED_FILES) {
    const item = await lstat(path.join(sourceRoot, relative));
    if (!item.isFile() || item.isSymbolicLink()) throw new Error(`Required public file is not a regular file: ${relative}`);
  }
  const temporary = destination + `.tmp-${process.pid}`;
  await mkdir(temporary, { recursive: false });
  const copied = [];
  try {
    for (const relative of [...PUBLIC_ROOT_FILES, ...PUBLIC_DIRECTORIES]) {
      try { await lstat(path.join(sourceRoot, relative)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await copyPublicTree(sourceRoot, temporary, relative, copied);
    }
    // The repository default remains compatible with GitHub Pages. Only the
    // VPS build uses one origin; no Railway fallback is shipped in this runtime.
    await writeFile(path.join(temporary, 'assets/board-runtime.js'),
      "window.VARGI_MARKET_CONFIG = Object.freeze({ mode: 'same-origin' });\n");
    for (const relative of ['board/index.html', 'board/admin/index.html', 'board/submit/index.html']) {
      const html = await readFile(path.join(temporary, relative), 'utf8');
      const runtimeAt = html.indexOf('/assets/board-runtime.js');
      const connectionAt = html.indexOf('/assets/board-connection.js');
      if (runtimeAt < 0 || connectionAt < 0 || runtimeAt > connectionAt) {
        throw new Error(`Board runtime is not included before the connection helper: ${relative}`);
      }
    }
    await rename(temporary, destination);
    return copied;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, output, ...extra] = process.argv.slice(2);
  if (!source || !output || extra.length) throw new Error('Usage: node deploy/vps/build-static.mjs SOURCE OUTPUT');
  const files = await buildStatic({ source, output });
  console.log(`Built public website: ${files.length} files; marketplace mode=same-origin`);
}
