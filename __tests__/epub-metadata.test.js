import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  extractEpubMetadata,
  extractUnitMetadata,
  extractDirectoryMetadata,
  normalizeIsbn,
  classifyIdentifier
} from '../src/metadata.js';

// ffprobe responses keyed by file basename
const ffprobeTags = {};

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFile: vi.fn((command, args, options, callback) => {
      if (args[0] === '-version') return callback(null, { stdout: 'ffprobe version 6.0', stderr: '' });
      const tags = ffprobeTags[path.basename(args[args.length - 1])] || {};
      callback(null, { stdout: JSON.stringify({ format: { tags } }), stderr: '' });
    })
  };
});

function createMockLogger() {
  const calls = { info: [], warn: [], debug: [], error: [] };
  const log = Object.fromEntries(Object.keys(calls).map(level => [level, (...args) => calls[level].push(args)]));
  return { log, calls };
}

/** Minimal ZIP writer: `mimetype` stored, everything else deflated */
async function writeZip(filePath, files) {
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
    local.writeUInt16LE(0x21, 12);
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
    central.writeUInt16LE(0x21, 14);
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
  await fs.writeFile(filePath, Buffer.concat([...locals, cd, eocd]));
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function opf({ metadata, manifest = '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', version = '3.0' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${metadata}</metadata>
  <manifest>${manifest}</manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
}

async function writeEpub(filePath, opfXml, extra = {}) {
  await writeZip(filePath, {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opfXml,
    'OEBPS/c1.xhtml': '<html/>',
    ...extra
  });
}

const DUNE_OPF = opf({
  version: '2.0',
  metadata: `
    <dc:title>Dune</dc:title>
    <dc:creator opf:role="edt">Some Editor</dc:creator>
    <dc:creator opf:role="aut" opf:file-as="Herbert, Frank">Frank Herbert</dc:creator>
    <dc:language>en</dc:language>
    <dc:date>1965-08-01</dc:date>
    <dc:identifier id="uid">urn:isbn:0441013597</dc:identifier>
    <dc:identifier opf:scheme="MOBI-ASIN">b000sefh1q</dc:identifier>
    <dc:identifier>urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier>`
});

describe('extractEpubMetadata', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-epub-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('reads a well-formed OPF (spec scenario: urn:isbn:0441013597 → 9780441013593)', async () => {
    const file = path.join(dir, 'Dune.epub');
    await writeEpub(file, DUNE_OPF);
    const { log, calls } = createMockLogger();

    const result = await extractEpubMetadata(file, log);

    expect(result).toMatchObject({
      title: 'Dune',
      author: 'Frank Herbert',
      language: 'en',
      year: '1965',
      readaloud: false,
      hasMetadata: true,
      source: 'epub'
    });
    expect(result.identifiers).toEqual([
      { type: 'isbn', value: '9780441013593', scheme: 'isbn' },
      { type: 'asin', value: 'B000SEFH1Q', scheme: 'asin' },
      { type: 'other', value: '12345678-1234-1234-1234-123456789abc', scheme: 'uuid' }
    ]);
    expect(calls.warn).toHaveLength(0);
  });

  test('takes the author role from a refining <meta property="role">', async () => {
    const file = path.join(dir, 'Dune.epub');
    await writeEpub(file, opf({
      metadata: `
        <dc:title id="t1">Dune</dc:title>
        <dc:title id="t2">Deluxe Edition</dc:title>
        <meta refines="#t1" property="title-type">main</meta>
        <dc:creator id="nrt">Scott Brick</dc:creator>
        <meta refines="#nrt" property="role" scheme="marc:relators">nrt</meta>
        <dc:creator id="author">Frank Herbert</dc:creator>
        <meta refines="#author" property="role" scheme="marc:relators">aut</meta>
        <dc:identifier id="isbn13">978-0-441-01359-3</dc:identifier>
        <meta refines="#isbn13" property="identifier-type" scheme="onix:codelist5">15</meta>`
    }));
    const { log } = createMockLogger();

    const result = await extractEpubMetadata(file, log);

    expect(result.title).toBe('Dune');
    expect(result.author).toBe('Frank Herbert');
    expect(result.identifiers).toEqual([{ type: 'isbn', value: '9780441013593', scheme: 'isbn' }]);
  });

  test('uses the first creator when no roles are present', async () => {
    const file = path.join(dir, 'Good Omens.epub');
    await writeEpub(file, opf({
      metadata: `
        <dc:title>Good Omens</dc:title>
        <dc:creator>Terry Pratchett</dc:creator>
        <dc:creator>Neil Gaiman</dc:creator>`
    }));
    const { log } = createMockLogger();

    const result = await extractEpubMetadata(file, log);

    expect(result.author).toBe('Terry Pratchett');
    expect(result.language).toBeNull();
    expect(result.identifiers).toEqual([]);
  });

  test.each([
    ['media-overlay attribute', '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml" media-overlay="s1"/><item id="s1" href="c1.smil" media-type="application/smil+xml"/>'],
    ['SMIL manifest item only', '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="s1" href="c1.smil" media-type="application/smil+xml"/>']
  ])('detects read-aloud EPUBs via %s', async (label, manifest) => {
    const file = path.join(dir, 'Dune (readaloud).epub');
    await writeEpub(file, opf({ metadata: '<dc:title>Dune</dc:title><dc:creator>Frank Herbert</dc:creator>', manifest }));
    const { log } = createMockLogger();

    const result = await extractEpubMetadata(file, log);

    expect(result.readaloud).toBe(true);
  });

  test('warns and returns null when the OPF named by container.xml is missing', async () => {
    const file = path.join(dir, 'Broken.epub');
    await writeZip(file, { mimetype: 'application/epub+zip', 'META-INF/container.xml': CONTAINER });
    const { log, calls } = createMockLogger();

    expect(await extractEpubMetadata(file, log)).toBeNull();
    expect(calls.warn.flat().join(' ')).toContain('Broken.epub');
  });

  test('warns and returns null when container.xml is missing', async () => {
    const file = path.join(dir, 'NoContainer.epub');
    await writeZip(file, { mimetype: 'application/epub+zip', 'OEBPS/content.opf': DUNE_OPF });
    const { log, calls } = createMockLogger();

    expect(await extractEpubMetadata(file, log)).toBeNull();
    expect(calls.warn).toHaveLength(1);
  });

  test('warns and returns null for a non-ZIP file', async () => {
    const file = path.join(dir, 'Fake.epub');
    await fs.writeFile(file, 'this is not a zip archive');
    const { log, calls } = createMockLogger();

    expect(await extractEpubMetadata(file, log)).toBeNull();
    expect(calls.warn).toHaveLength(1);
    expect(calls.warn[0].join(' ')).toContain('Fake.epub');
  });

  test('refuses OPF entries above the size cap', async () => {
    const file = path.join(dir, 'Huge.epub');
    const padding = `<!-- ${'x'.repeat(5 * 1024 * 1024)} -->`;
    await writeEpub(file, DUNE_OPF.replace('<manifest>', `${padding}<manifest>`));
    const { log, calls } = createMockLogger();

    expect(await extractEpubMetadata(file, log)).toBeNull();
    expect(calls.warn.flat().join(' ')).toContain('exceeds');
  });
});

describe('identifier helpers', () => {
  test.each([
    ['0441013597', '9780441013593'],
    ['0-441-01359-7', '9780441013593'],
    ['080442957X', '9780804429573'],
    ['9780441013593', '9780441013593'],
    ['0441013598', null], // bad ISBN-10 checksum
    ['9780441013594', null], // bad ISBN-13 checksum
    ['B000SEFH1Q', null]
  ])('normalizeIsbn(%s) → %s', (input, expected) => {
    expect(normalizeIsbn(input)).toBe(expected);
  });

  test('keeps a declared but invalid ISBN as other with its scheme', () => {
    expect(classifyIdentifier('urn:isbn:0441013598')).toEqual({ type: 'other', value: '0441013598', scheme: 'isbn' });
  });

  test('classifies bare ISBNs and Amazon B0 ASINs without a scheme', () => {
    expect(classifyIdentifier('0441013597')).toEqual({ type: 'isbn', value: '9780441013593', scheme: 'isbn' });
    expect(classifyIdentifier('B000SEFH1Q').type).toBe('asin');
    expect(classifyIdentifier('http://example.com/book/1')).toEqual({ type: 'other', value: 'http://example.com/book/1', scheme: null });
  });
});

describe('extractUnitMetadata precedence', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-unit-'));
    for (const key of Object.keys(ffprobeTags)) delete ffprobeTags[key];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('mixed m4b + epub: m4b tags are primary and EPUB identifiers are merged', async () => {
    const m4b = path.join(dir, 'Dune.m4b');
    const epub = path.join(dir, 'Dune.epub');
    await fs.writeFile(m4b, 'fake');
    await writeEpub(epub, DUNE_OPF);
    ffprobeTags['Dune.m4b'] = { title: 'DUNE', ARTIST: 'Frank Herbert', AUDIBLE_ASIN: 'B002V1OF70' };
    const { log } = createMockLogger();

    const result = await extractUnitMetadata([epub, m4b], log);

    expect(result).toMatchObject({ title: 'DUNE', author: 'Frank Herbert', source: 'file', primaryFile: m4b, language: 'en', hasMetadata: true });
    expect(result.identifiers).toEqual([
      { type: 'asin', value: 'B002V1OF70', scheme: 'asin' },
      { type: 'isbn', value: '9780441013593', scheme: 'isbn' },
      { type: 'asin', value: 'B000SEFH1Q', scheme: 'asin' },
      { type: 'other', value: '12345678-1234-1234-1234-123456789abc', scheme: 'uuid' }
    ]);
    expect(result.files.map(f => [path.basename(f.path), f.kind, f.readaloud])).toEqual([
      ['Dune.epub', 'epub', false],
      ['Dune.m4b', 'audio', false]
    ]);
  });

  test('non-read-aloud epub outranks mp3, which outranks the read-aloud epub', async () => {
    const mp3 = path.join(dir, '01.mp3');
    const epub = path.join(dir, 'Dune.epub');
    const readaloud = path.join(dir, 'Dune (readaloud).epub');
    await fs.writeFile(mp3, 'fake');
    await writeEpub(epub, DUNE_OPF);
    await writeEpub(readaloud, opf({
      metadata: '<dc:title>Dune (Read-Aloud)</dc:title><dc:creator>Storyteller</dc:creator>',
      manifest: '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml" media-overlay="s1"/>'
    }));
    ffprobeTags['01.mp3'] = { title: 'Dune Track 1', artist: 'Frank Herbert' };
    const { log } = createMockLogger();

    expect((await extractUnitMetadata([mp3, epub, readaloud], log)).primaryFile).toBe(epub);
    const withoutEpub = await extractUnitMetadata([mp3, readaloud], log);
    expect(withoutEpub).toMatchObject({ primaryFile: mp3, title: 'Dune Track 1' });
    expect(withoutEpub.files.find(f => f.path === readaloud).readaloud).toBe(true);
    expect((await extractUnitMetadata([readaloud], log)).title).toBe('Dune (Read-Aloud)');
  });

  test('epub-only unit uses the EPUB package metadata', async () => {
    const epub = path.join(dir, 'Dune.epub');
    await writeEpub(epub, DUNE_OPF);
    const { log } = createMockLogger();

    const result = await extractDirectoryMetadata(dir, log);

    expect(result).toMatchObject({ title: 'Dune', author: 'Frank Herbert', source: 'epub', language: 'en' });
  });

  test('a corrupt epub falls through to the next source', async () => {
    const epub = path.join(dir, 'Dune.epub');
    const mp3 = path.join(dir, 'Dune.mp3');
    await fs.writeFile(epub, 'not a zip');
    await fs.writeFile(mp3, 'fake');
    ffprobeTags['Dune.mp3'] = { title: 'Dune', artist: 'Frank Herbert' };
    const { log, calls } = createMockLogger();

    const result = await extractUnitMetadata([epub, mp3], log);

    expect(result.primaryFile).toBe(mp3);
    expect(calls.warn).toHaveLength(1);
  });

  test('only the first mp3/m4a track is probed', async () => {
    const tracks = ['02.mp3', '01.mp3', '03.m4a'].map(name => path.join(dir, name));
    for (const track of tracks) await fs.writeFile(track, 'fake');
    ffprobeTags['01.mp3'] = { title: 'Track One', artist: 'A' };
    ffprobeTags['02.mp3'] = { title: 'Track Two', artist: 'A', isbn: '0441013597' };
    const { log } = createMockLogger();

    const result = await extractUnitMetadata(tracks.map(p => ({ path: p })), log);

    expect(result.title).toBe('Track One');
    expect(result.identifiers).toEqual([]);
    expect(result.files.filter(f => f.metadata)).toHaveLength(1);
  });

  test('returns null when no supported files are given', async () => {
    const { log } = createMockLogger();
    expect(await extractUnitMetadata([path.join(dir, 'cover.jpg')], log)).toBeNull();
    expect(await extractUnitMetadata([], log)).toBeNull();
  });
});
