/**
 * Book fixtures for end-to-end tests: EPUBs as real ZIPs, audio files that a fake ffprobe
 * understands, tree snapshots, and a capturing logger.
 */
import { vi } from 'vitest';
import fs from 'fs-extra';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';

/** Minimal ZIP writer: `mimetype` stored, everything else deflated */
export async function writeZip(filePath, files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const method = name === 'mimetype' ? 0 : 8;
    const stored = method === 0 ? data : zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, Buffer.concat([...locals, cd, eocd]));
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

/** EPUB fixture; `readaloud` adds a media overlay, `note` varies the bytes */
export async function writeEpub(filePath, { title = 'Dune', author = 'Frank Herbert', language = 'en', isbn = null, readaloud = false, note = '' } = {}) {
  const manifest = readaloud
    ? '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml" media-overlay="s1"/><item id="s1" href="c1.smil" media-type="application/smil+xml"/>'
    : '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>';
  const identifier = isbn ? `<dc:identifier id="uid">urn:isbn:${isbn}</dc:identifier>` : '';
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>${language}</dc:language>${identifier}
  </metadata>
  <manifest>${manifest}</manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
  await writeZip(filePath, {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/c1.xhtml': `<html><body>${note}</body></html>`
  });
}

const AUDIO_MAGIC = 'FAKEAUDIO';

/** Audio fixture whose ffprobe format tags travel inside the file (see fakeFfprobe) */
export async function writeAudio(filePath, tags = { title: 'Dune', artist: 'Frank Herbert' }, note = '') {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${AUDIO_MAGIC}${JSON.stringify(tags)}\n${note}`);
}

/**
 * `execFile` stand-in for ffprobe: `-version` succeeds, and probing a writeAudio fixture
 * returns its tags. Anything else probes as untagged.
 */
export function fakeFfprobe(command, args, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  if (args.includes('-version')) return cb(null, { stdout: 'ffprobe version 6.0 (test)', stderr: '' });
  let tags = {};
  try {
    const text = readFileSync(args.at(-1), 'utf8');
    if (text.startsWith(AUDIO_MAGIC)) tags = JSON.parse(text.slice(AUDIO_MAGIC.length).split('\n')[0]);
  } catch {
    // Unreadable or not a fixture: untagged
  }
  cb(null, { stdout: JSON.stringify({ format: { tags } }), stderr: '' });
}

/** Logger whose calls are also captured per level as joined strings */
export function createLog() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  const log = Object.fromEntries(Object.keys(calls).map(level => [level, vi.fn((...args) => calls[level].push(args.join(' ')))]));
  return { log, calls };
}

/** Relative path → SHA-256 for every file and directory under root ('<dir>' for directories) */
export async function snapshot(root) {
  const out = {};
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        out[rel] = '<dir>';
        await walk(full);
      } else {
        out[rel] = crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex');
      }
    }
  }
  await walk(root);
  return out;
}

/** Relative path → mtimeMs for every file under root, to prove nothing was rewritten */
export async function mtimes(root) {
  const out = {};
  for (const rel of Object.keys(await snapshot(root))) {
    const stat = await fs.stat(path.join(root, rel));
    if (stat.isFile()) out[rel] = stat.mtimeMs;
  }
  return out;
}
