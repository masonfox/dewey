import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import { promises as fsPromises } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Job, JobState, JobType } from '../src/job.js';
import { JobQueue } from '../src/jobQueue.js';
import { migrateJob, migratePath, planUnit, executePlan, sweepStalePartials, REVIEW_FILE } from '../src/migrate.js';

// ffprobe is unavailable, so audio files carry no embedded metadata and names drive heuristics
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFile: vi.fn((...args) => args[args.length - 1](new Error('ffprobe not installed (test)')))
  };
});

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
async function writeEpub(filePath, { title = 'Dune', author = 'Frank Herbert', readaloud = false, note = '' } = {}) {
  const manifest = readaloud
    ? '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml" media-overlay="s1"/><item id="s1" href="c1.smil" media-type="application/smil+xml"/>'
    : '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>';
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>en</dc:language>
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

function createLog() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  const log = Object.fromEntries(Object.keys(calls).map(level => [level, vi.fn((...args) => calls[level].push(args.join(' ')))]));
  return { log, calls };
}

/** Relative path → SHA-256 for every file and directory under root ('<dir>' for directories) */
async function snapshot(root) {
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

async function partialsUnder(root) {
  return Object.keys(await snapshot(root)).filter(p => path.basename(p).startsWith('.dewey-partial-'));
}

const ENV_KEYS = ['SOURCE_DIR', 'DEST_DIR', 'REVIEW_DIR', 'DRY_RUN', 'LIBRARY_LAYOUT', 'INGEST_EBOOKS', 'PUID', 'PGID'];
let saved;
let testDir;
let sourceDir;
let destDir;
let reviewDir;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-safety-'));
  sourceDir = path.join(testDir, 'incoming');
  destDir = path.join(testDir, 'library');
  reviewDir = path.join(sourceDir, '.dewey-review');
  for (const k of ['REVIEW_DIR', 'DRY_RUN', 'LIBRARY_LAYOUT', 'INGEST_EBOOKS']) delete process.env[k];
  Object.assign(process.env, { SOURCE_DIR: sourceDir, DEST_DIR: destDir, PUID: '0', PGID: '0' });
  await fs.ensureDir(sourceDir);
  await fs.ensureDir(destDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await fs.remove(testDir);
});

async function run(source, log = createLog().log) {
  const job = await Job.fromPath(source);
  return migrateJob(job, job.createLogger(log));
}

async function reviewFolders() {
  return (await fs.readdir(reviewDir)).sort();
}

describe('collision classification (6.2)', () => {
  test('identical re-ingestion removes the source and leaves one library copy', async () => {
    const source = path.join(sourceDir, 'Frank Herbert - Dune.m4b');
    await fs.writeFile(source, 'dune audio');
    await run(source);
    const bookDir = path.join(destDir, 'Frank Herbert', 'Dune');
    const before = await snapshot(destDir);

    await fs.writeFile(source, 'dune audio');
    const { log, calls } = createLog();
    const result = await run(source, log);

    expect(result).toEqual({ author: 'Frank Herbert', title: 'Dune', files: 1 });
    expect(await fs.pathExists(source)).toBe(false);
    expect(await fs.readdir(bookDir)).toEqual(['Frank Herbert - Dune.m4b']);
    expect(await snapshot(destDir)).toEqual(before);
    expect(calls.info.some(l => l.includes('skipped identical: "Frank Herbert - Dune.m4b"'))).toBe(true);
  });

  test('a different same-named file leaves the library untouched and quarantines with reason conflict', async () => {
    await writeEpub(path.join(destDir, 'Frank Herbert', 'Dune', 'Frank Herbert - Dune.epub'), { note: 'library' });
    const before = await snapshot(destDir);
    const source = path.join(sourceDir, 'Frank Herbert - Dune.epub');
    await writeEpub(source, { note: 'a different edition' });

    const { log, calls } = createLog();
    const result = await run(source, log);

    expect(await snapshot(destDir)).toEqual(before);
    expect(result).toMatchObject({ outcome: 'quarantined', reason: 'conflict' });
    expect(await fs.pathExists(source)).toBe(false);
    const [folder] = await reviewFolders();
    expect(await fs.pathExists(path.join(reviewDir, folder, 'Frank Herbert - Dune.epub'))).toBe(true);
    const review = await fs.readJson(path.join(reviewDir, folder, REVIEW_FILE));
    expect(review).toMatchObject({ reason: 'conflict', paths: [path.join(destDir, 'Frank Herbert', 'Dune', 'Frank Herbert - Dune.epub')] });
    expect(review.explanation).toMatch(/different file already exists/);
    expect(new Date(review.timestamp).toString()).not.toBe('Invalid Date');
    expect(calls.info.some(l => l.includes('conflicting: "Frank Herbert - Dune.epub"'))).toBe(true);
  });

  test('one conflicting file in a three-file directory unit writes none of them', async () => {
    const bookDir = path.join(destDir, 'Frank Herbert', 'Dune');
    await fs.ensureDir(bookDir);
    await fs.writeFile(path.join(bookDir, '02.mp3'), 'library track 2');
    const before = await snapshot(destDir);
    const unitDir = path.join(sourceDir, 'Frank Herbert - Dune');
    await fs.ensureDir(unitDir);
    for (const n of ['01', '02', '03']) await fs.writeFile(path.join(unitDir, `${n}.mp3`), `incoming ${n}`);

    const result = await run(unitDir);

    expect(result.outcome).toBe('quarantined');
    expect(await snapshot(destDir)).toEqual(before);
    const [folder] = await reviewFolders();
    expect((await fs.readdir(path.join(reviewDir, folder, 'Frank Herbert - Dune'))).sort()).toEqual(['01.mp3', '02.mp3', '03.mp3']);
  });

  test('a partly new unit copies only the new files and removes the whole source directory', async () => {
    const bookDir = path.join(destDir, 'Frank Herbert', 'Dune');
    await fs.ensureDir(bookDir);
    await fs.writeFile(path.join(bookDir, 'Dune.m4b'), 'dune audio');
    const libraryStat = await fs.stat(path.join(bookDir, 'Dune.m4b'));
    const unitDir = path.join(sourceDir, 'Frank Herbert - Dune');
    await fs.ensureDir(unitDir);
    await fs.writeFile(path.join(unitDir, 'Dune.m4b'), 'dune audio');
    await writeEpub(path.join(unitDir, 'Dune.epub'));

    const { log, calls } = createLog();
    const result = await run(unitDir, log);

    expect(result).toEqual({ author: 'Frank Herbert', title: 'Dune', files: 2 });
    expect((await fs.readdir(bookDir)).sort()).toEqual(['Dune.epub', 'Dune.m4b']);
    expect((await fs.stat(path.join(bookDir, 'Dune.m4b'))).mtimeMs).toBe(libraryStat.mtimeMs);
    expect(await fs.pathExists(unitDir)).toBe(false);
    expect(calls.info.some(l => l.includes('copied: "Dune.epub"'))).toBe(true);
    expect(calls.info.some(l => l.includes('skipped identical: "Dune.m4b"'))).toBe(true);
  });
});

describe('staged transfer (6.3)', () => {
  test('a mid-unit copy failure leaves no partial files and keeps every source', async () => {
    const unitDir = path.join(sourceDir, 'Frank Herbert - Dune');
    await fs.ensureDir(unitDir);
    for (const n of ['01', '02', '03']) await fs.writeFile(path.join(unitDir, `${n}.mp3`), `track ${n}`);
    const realCopy = fsPromises.copyFile.bind(fsPromises);
    let calls = 0;
    vi.spyOn(fsPromises, 'copyFile').mockImplementation(async (src, dest, mode) => {
      if (++calls === 2) {
        await fs.writeFile(dest, 'half');
        throw new Error('disk full (simulated)');
      }
      return realCopy(src, dest, mode);
    });

    await expect(run(unitDir)).rejects.toThrow('disk full');

    expect(await partialsUnder(destDir)).toEqual([]);
    expect((await fs.readdir(unitDir)).sort()).toEqual(['01.mp3', '02.mp3', '03.mp3']);
    // The file renamed before the failure stays; it is identical to its source
    expect(await fs.readdir(path.join(destDir, 'Frank Herbert', 'Dune'))).toEqual(['01.mp3']);

    vi.restoreAllMocks();
    expect(await run(unitDir)).toEqual({ author: 'Frank Herbert', title: 'Dune', files: 3 });
    expect((await fs.readdir(path.join(destDir, 'Frank Herbert', 'Dune'))).sort()).toEqual(['01.mp3', '02.mp3', '03.mp3']);
    expect(await fs.pathExists(unitDir)).toBe(false);
  });

  test('a crash after rename, before source removal, reprocesses as identical and removes sources', async () => {
    const unitDir = path.join(sourceDir, 'Frank Herbert - Dune');
    await fs.ensureDir(unitDir);
    await fs.writeFile(path.join(unitDir, 'Dune.m4b'), 'dune audio');
    await writeEpub(path.join(unitDir, 'Dune.epub'));
    const realRemove = fs.remove.bind(fs);
    vi.spyOn(fs, 'remove').mockImplementation(async p => {
      if (path.resolve(p) === path.resolve(unitDir)) throw new Error('process killed (simulated)');
      return realRemove(p);
    });

    await expect(run(unitDir)).rejects.toThrow('process killed');
    const placed = await snapshot(destDir);
    expect(await fs.pathExists(unitDir)).toBe(true);

    vi.restoreAllMocks();
    const { log, calls } = createLog();
    expect(await run(unitDir, log)).toEqual({ author: 'Frank Herbert', title: 'Dune', files: 2 });
    expect(await snapshot(destDir)).toEqual(placed);
    expect(await fs.pathExists(unitDir)).toBe(false);
    expect(calls.info.filter(l => l.includes('skipped identical'))).toHaveLength(2);
  });

  test('never overwrites a destination that appears between plan and rename', async () => {
    const source = path.join(sourceDir, 'Frank Herbert - Dune.m4b');
    await fs.writeFile(source, 'incoming audio');
    const job = await Job.fromPath(source);
    const { buildUnit } = await import('../src/migrate.js');
    const log = createLog().log;
    const plan = await planUnit(await buildUnit(job, log), log);
    expect(plan.actions.map(a => a.op)).toEqual(['copy']);
    await fs.ensureDir(plan.bookDir);
    await fs.writeFile(plan.actions[0].dest, 'someone else wrote this');

    await expect(executePlan(plan, { log })).rejects.toThrow(/refusing to overwrite/);

    expect(await fs.readFile(plan.actions[0].dest, 'utf8')).toBe('someone else wrote this');
    expect(await partialsUnder(destDir)).toEqual([]);
    expect(await fs.pathExists(source)).toBe(true);
  });
});

describe('startup sweep (6.4)', () => {
  test('removes stale partial files and keeps real files', async () => {
    const bookDir = path.join(destDir, 'Frank Herbert', 'Dune');
    await fs.ensureDir(bookDir);
    await fs.writeFile(path.join(bookDir, 'Dune.m4b'), 'real');
    await fs.writeFile(path.join(bookDir, '.dewey-partial-ABCDEF12-Dune.epub'), 'half');
    await fs.writeFile(path.join(destDir, 'Frank Herbert', '.dewey-partial-ABCDEF12-x.mp3'), 'half');
    await fs.writeFile(path.join(bookDir, '.hidden-real'), 'keep');

    const { log } = createLog();
    const removed = await sweepStalePartials(log);

    expect(removed).toHaveLength(2);
    expect(await partialsUnder(destDir)).toEqual([]);
    expect((await fs.readdir(bookDir)).sort()).toEqual(['.hidden-real', 'Dune.m4b']);
  });

  test('dry-run sweep only reports', async () => {
    const stale = path.join(destDir, 'A', 'B', '.dewey-partial-X-y.m4b');
    await fs.ensureDir(path.dirname(stale));
    await fs.writeFile(stale, 'half');
    process.env.DRY_RUN = 'true';

    expect(await sweepStalePartials(createLog().log)).toEqual([stale]);
    expect(await fs.pathExists(stale)).toBe(true);
  });
});

describe('review quarantine (6.5)', () => {
  test('an ambiguous unit moves to REVIEW_DIR with candidate paths and leaves DEST_DIR unchanged', async () => {
    const messiah = path.join(destDir, 'Frank Herbert', 'Dune Messiah');
    await fs.ensureDir(messiah);
    await fs.writeFile(path.join(messiah, 'Dune Messiah.m4b'), 'messiah');
    const before = await snapshot(destDir);
    const author = path.join(sourceDir, 'Frank Herbert');
    const unitDir = path.join(author, 'Frank Herbert - Dune');
    await fs.ensureDir(unitDir);
    await fs.writeFile(path.join(unitDir, 'Dune.m4b'), 'dune');
    await fs.writeFile(path.join(unitDir, 'cover.jpg'), 'cover');

    const { log, calls } = createLog();
    const result = await run(unitDir, log);

    expect(result).toMatchObject({ outcome: 'quarantined', reason: 'ambiguous' });
    expect(await snapshot(destDir)).toEqual(before);
    const [folder] = await reviewFolders();
    expect(folder).toMatch(/^\d{14}-Frank Herbert - Dune$/);
    // Relative structure under SOURCE_DIR is kept, non-book files included
    const moved = path.join(reviewDir, folder, 'Frank Herbert', 'Frank Herbert - Dune');
    expect((await fs.readdir(moved)).sort()).toEqual(['Dune.m4b', 'cover.jpg']);
    const review = await fs.readJson(path.join(reviewDir, folder, REVIEW_FILE));
    expect(review).toMatchObject({ reason: 'ambiguous', paths: [messiah] });
    expect(review.explanation).toBeTruthy();
    expect(await fs.pathExists(author)).toBe(false);
    expect(calls.warn.some(l => l.includes('Quarantined') && l.includes(path.join(reviewDir, folder)))).toBe(true);
  });

  test('appends a suffix when the review folder name already exists', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T12:34:56Z'));
    await fs.ensureDir(path.join(reviewDir, '20261019123456-Frank Herbert - Dune.epub'));
    await writeEpub(path.join(destDir, 'Frank Herbert', 'Dune', 'Frank Herbert - Dune.epub'), { note: 'library' });
    const source = path.join(sourceDir, 'Frank Herbert - Dune.epub');
    await writeEpub(source, { note: 'other' });

    const result = await run(source);

    expect(result.reviewPath).toBe(path.join(reviewDir, '20261019123456-Frank Herbert - Dune.epub-2'));
    expect(await fs.pathExists(path.join(result.reviewPath, 'Frank Herbert - Dune.epub'))).toBe(true);
    expect(await fs.readdir(path.join(reviewDir, '20261019123456-Frank Herbert - Dune.epub'))).toEqual([]);
  });

  test('a quarantined job completes with outcome quarantined and is not retried', async () => {
    await fs.ensureDir(path.join(destDir, 'Frank Herbert', 'Dune'));
    await fs.writeFile(path.join(destDir, 'Frank Herbert', 'Dune', 'Frank Herbert - Dune.m4b'), 'library');
    const source = path.join(sourceDir, 'Frank Herbert - Dune.m4b');
    await fs.writeFile(source, 'different');
    const queue = new JobQueue({ stabilityTimeout: 0, batchProcessDelay: 10, sourceDir });
    const { log, calls } = createLog();
    queue.setLogger(log);
    const job = new Job(source, JobType.FILE);

    await queue.processJob(job);

    expect(job.state).toBe(JobState.COMPLETED);
    expect(job.result.outcome).toBe('quarantined');
    expect(job.retryCount).toBe(0);
    expect(job.error).toBeNull();
    expect(calls.error).toEqual([]);
    expect(calls.info.some(l => l.includes('quarantined for review'))).toBe(true);
  });
});

describe('DRY_RUN (6.6)', () => {
  test('a mixed-format run changes nothing in SOURCE_DIR, DEST_DIR, or REVIEW_DIR and logs planned actions', async () => {
    const bookDir = path.join(destDir, 'Frank Herbert', 'Dune');
    await fs.ensureDir(bookDir);
    await fs.writeFile(path.join(bookDir, 'Dune.m4b'), 'dune audio');
    await writeEpub(path.join(destDir, 'Frank Herbert', 'Children of Dune', 'Children of Dune.epub'), { title: 'Children of Dune', note: 'library' });
    await writeEpub(path.join(sourceDir, 'Frank Herbert - Dune.epub'));
    await writeEpub(path.join(sourceDir, 'Frank Herbert - Children of Dune.epub'), { title: 'Children of Dune', note: 'conflict' });
    const unitDir = path.join(sourceDir, 'Brian Herbert', 'Brian Herbert - Dreamer of Dune');
    await fs.ensureDir(unitDir);
    await fs.writeFile(path.join(unitDir, '01.mp3'), 'track');
    await writeEpub(path.join(unitDir, 'Dreamer.epub'), { title: 'Dreamer of Dune', author: 'Brian Herbert', readaloud: true });
    process.env.DRY_RUN = 'true';
    process.env.LIBRARY_LAYOUT = 'bookorbit';

    const before = await snapshot(testDir);
    const mutators = ['ensureDir', 'move', 'remove', 'rename', 'chmod', 'chown', 'writeFile', 'writeJson', 'copy', 'mkdir']
      .map(name => vi.spyOn(fs, name));
    const nativeCopy = vi.spyOn(fsPromises, 'copyFile');
    const { log, calls } = createLog();

    await migratePath(sourceDir, log);

    expect(await snapshot(testDir)).toEqual(before);
    expect(await fs.pathExists(reviewDir)).toBe(false);
    for (const spy of [...mutators, nativeCopy]) expect(spy).not.toHaveBeenCalled();
    const info = calls.info.join('\n');
    expect(info).toContain(`🧪 [dry-run] would have copied: "Frank Herbert - Dune.epub" → "Dune.epub" (renamed by layout) into ${bookDir}`);
    expect(info).toContain('🧪 [dry-run] would quarantine "Frank Herbert - Children of Dune.epub" (conflict');
    expect(info).toContain(`🧪 [dry-run] would create folder ${path.join(destDir, 'Brian Herbert', 'Dreamer of Dune')}`);
    expect(info).toContain('"Dreamer.epub" → "Dreamer of Dune (readaloud).epub" (renamed by layout)');
    expect(info).toContain(`🧪 [dry-run] would remove source "${unitDir}"`);
    expect(calls.error).toEqual([]);
  });
});

describe('layout naming in plans (6.7)', () => {
  async function unitFor(dir, names, extra = {}) {
    await fs.ensureDir(dir);
    const files = [];
    for (const [name, readaloud] of names) {
      const p = path.join(dir, name);
      if (name.endsWith('.epub')) await writeEpub(p, { readaloud, note: name });
      else await fs.writeFile(p, `audio ${name}`);
      files.push({ path: p, name, kind: name.endsWith('.epub') ? 'epub' : 'audio', readaloud, metadata: null, size: (await fs.stat(p)).size });
    }
    return {
      job: { id: 'TESTJOB1' }, type: JobType.DIRECTORY, sourcePath: dir, displayName: path.basename(dir),
      author: 'Frank Herbert', title: 'Dune', formats: [...new Set(files.map(f => f.kind))], metadata: null, files, ...extra
    };
  }
  const NAMES = [['Dune.m4b', false], ['dune_herbert_retail.epub', false], ['dune_herbert_ra.epub', true]];
  const destOf = plan => Object.fromEntries(plan.actions.map(a => [path.basename(a.src), [path.relative(destDir, a.dest), a.op, a.renamed]]));

  test('audiobookshelf keeps original names', async () => {
    const plan = await planUnit(await unitFor(path.join(sourceDir, 'Dune'), NAMES), createLog().log);
    expect(plan.outcome).toBe('place');
    expect(destOf(plan)).toEqual({
      'Dune.m4b': [path.join('Frank Herbert', 'Dune', 'Dune.m4b'), 'copy', false],
      'dune_herbert_retail.epub': [path.join('Frank Herbert', 'Dune', 'dune_herbert_retail.epub'), 'copy', false],
      'dune_herbert_ra.epub': [path.join('Frank Herbert', 'Dune', 'dune_herbert_ra.epub'), 'copy', false]
    });
  });

  test('bookorbit gives ebooks canonical names and keeps audio names', async () => {
    process.env.LIBRARY_LAYOUT = 'bookorbit';
    const plan = await planUnit(await unitFor(path.join(sourceDir, 'Dune'), NAMES), createLog().log);
    expect(destOf(plan)).toEqual({
      'Dune.m4b': [path.join('Frank Herbert', 'Dune', 'Dune.m4b'), 'copy', false],
      'dune_herbert_retail.epub': [path.join('Frank Herbert', 'Dune', 'Dune.epub'), 'copy', true],
      'dune_herbert_ra.epub': [path.join('Frank Herbert', 'Dune', 'Dune (readaloud).epub'), 'copy', true]
    });
  });

  test('bookorbit uses a matched folder\'s existing title segment', async () => {
    process.env.LIBRARY_LAYOUT = 'bookorbit';
    await fs.ensureDir(path.join(destDir, 'Frank Herbert', 'Dune'));
    await fs.writeFile(path.join(destDir, 'Frank Herbert', 'Dune', 'Dune.m4b'), 'audio');
    const unit = await unitFor(path.join(sourceDir, 'x'), [['retail.epub', false]], { author: 'Herbert, Frank', title: 'DUNE' });
    const plan = await planUnit(unit, createLog().log);
    expect(plan.match.outcome).toBe('deterministic');
    expect(destOf(plan)).toEqual({ 'retail.epub': [path.join('Frank Herbert', 'Dune', 'Dune.epub'), 'copy', true] });
  });

  test('audiobookshelf suffixes a read-aloud EPUB that shares the library original\'s name', async () => {
    const bookDir = path.join(destDir, 'Frank Herbert', 'Dune');
    await writeEpub(path.join(bookDir, 'Dune.epub'), { note: 'original' });
    const plan = await planUnit(await unitFor(path.join(sourceDir, 'ra'), [['Dune.epub', true]]), createLog().log);
    expect(destOf(plan)).toEqual({ 'Dune.epub': [path.join('Frank Herbert', 'Dune', 'Dune (readaloud).epub'), 'copy', true] });

    const { log, calls } = createLog();
    await executePlan(plan, { log });
    expect((await fs.readdir(bookDir)).sort()).toEqual(['Dune (readaloud).epub', 'Dune.epub']);
    const info = calls.info.join('\n');
    expect(info).toContain(`📂 Placing "ra" in ${bookDir}`);
    expect(info).toContain('copied: "Dune.epub" → "Dune (readaloud).epub" (renamed by layout)');
    expect(info).toContain('🎉 Migrated: "ra" → "Frank Herbert / Dune" (1 copied, 0 identical)');
  });

  test('two unit files mapping to the same name are a conflict', async () => {
    process.env.LIBRARY_LAYOUT = 'bookorbit';
    const plan = await planUnit(await unitFor(path.join(sourceDir, 'Dune'), [['a.epub', false], ['b.epub', false]]), createLog().log);
    expect(plan).toMatchObject({ outcome: 'quarantine', reason: 'conflict' });
    expect(plan.conflicts[0].why).toMatch(/same destination name/);
  });
});
