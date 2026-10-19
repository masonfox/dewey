/**
 * Acceptance tests (tasks 7.1–7.6): the real pipeline end to end, through migratePath and
 * JobQueue, against temp SOURCE/DEST/REVIEW dirs. ffprobe is faked from tags embedded in the
 * audio fixtures; AI normalization is mocked to echo embedded metadata, and AI match resolution
 * stays real (and unusable, since setup clears the AI environment).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { Job, JobState, JobType } from '../src/job.js';
import { JobQueue } from '../src/jobQueue.js';
import { migratePath, REVIEW_FILE } from '../src/migrate.js';
import { writeEpub, writeAudio, createLog, snapshot, mtimes } from './helpers/books.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  const { fakeFfprobe } = await import('./helpers/books.js');
  return { ...actual, execFile: vi.fn(fakeFfprobe) };
});

// A well-behaved AI normalizes to the embedded author/title
vi.mock('../src/ai.js', async () => {
  const actual = await vi.importActual('../src/ai.js');
  return {
    ...actual,
    normalizeViaAI: vi.fn(async (name, fallbackAuthor, fallbackTitle, log, parentDir, metadata) =>
      metadata?.author && metadata?.title ? { author: metadata.author, title: metadata.title } : null)
  };
});

const LAYOUTS = ['audiobookshelf', 'bookorbit'];
const ENV_KEYS = ['SOURCE_DIR', 'DEST_DIR', 'REVIEW_DIR', 'DRY_RUN', 'LIBRARY_LAYOUT', 'INGEST_EBOOKS', 'PUID', 'PGID'];
let saved;
let testDir;
let sourceDir;
let destDir;
let reviewDir;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-acceptance-'));
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
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await fs.remove(testDir);
});

const bookDir = (author = 'Frank Herbert', title = 'Dune') => path.join(destDir, author, title);
const dropDuneAudio = (name = 'Dune.m4b') => writeAudio(path.join(sourceDir, name));
const dropDuneEpub = (name = 'Dune.epub', opts = {}) => writeEpub(path.join(sourceDir, name), opts);

/** Run the whole SOURCE_DIR, as a startup scan does */
async function ingest(log = createLog().log) {
  await migratePath(sourceDir, log);
}

async function sourceLeft() {
  return Object.keys(await snapshot(sourceDir)).filter(p => !p.startsWith('.dewey-review'));
}

describe('7.1 EPUB joins an existing audiobook', () => {
  test('Dune.epub ingested next to Frank Herbert/Dune/Dune.m4b ends in that folder', async () => {
    await writeAudio(path.join(bookDir(), 'Dune.m4b'));
    await dropDuneEpub();

    const { log, calls } = createLog();
    await ingest(log);

    expect((await fs.readdir(bookDir())).sort()).toEqual(['Dune.epub', 'Dune.m4b']);
    expect(await fs.readdir(destDir)).toEqual(['Frank Herbert']);
    expect(await fs.readdir(path.join(destDir, 'Frank Herbert'))).toEqual(['Dune']);
    expect(await sourceLeft()).toEqual([]);
    expect(await fs.pathExists(reviewDir)).toBe(false);
    expect(calls.info.some(l => l.includes('Match deterministic match') && l.includes('book Frank Herbert/Dune'))).toBe(true);
    expect(calls.info.some(l => l.includes(`Placing "Dune.epub" in ${bookDir()}`))).toBe(true);
    expect(calls.error).toEqual([]);
  });
});

describe('7.2 ingestion-order independence', () => {
  async function runInOrder(order) {
    await fs.emptyDir(destDir);
    for (const step of order) {
      if (step === 'epub') await dropDuneEpub('dune_herbert_retail.epub');
      else await dropDuneAudio();
      await ingest();
    }
    expect(await sourceLeft()).toEqual([]);
    return snapshot(destDir);
  }

  test.each(LAYOUTS)('EPUB-first and audiobook-first produce identical trees (%s)', async layout => {
    process.env.LIBRARY_LAYOUT = layout;
    const epubFirst = await runInOrder(['epub', 'audio']);
    const audioFirst = await runInOrder(['audio', 'epub']);

    expect(audioFirst).toEqual(epubFirst);
    const epubName = layout === 'bookorbit' ? 'Dune.epub' : 'dune_herbert_retail.epub';
    expect(Object.keys(epubFirst).sort()).toEqual([
      'Frank Herbert',
      path.join('Frank Herbert', 'Dune'),
      path.join('Frank Herbert', 'Dune', 'Dune.m4b'),
      path.join('Frank Herbert', 'Dune', epubName)
    ].sort());
  });
});

describe('7.3 simultaneous arrival through JobQueue', () => {
  test('loose Dune.epub and Dune.m4b enqueued together produce one book folder, processed serially', async () => {
    await dropDuneEpub();
    await dropDuneAudio();
    const queue = new JobQueue({ stabilityTimeout: 50, batchProcessDelay: 20, sourceDir });
    const { log, calls } = createLog();
    queue.setLogger(log);

    // D4: matching relies on one unit seeing the previous unit's placement
    let active = 0;
    let maxActive = 0;
    const processJob = queue.processJob.bind(queue);
    vi.spyOn(queue, 'processJob').mockImplementation(async job => {
      maxActive = Math.max(maxActive, ++active);
      try { return await processJob(job); } finally { active--; }
    });

    await Promise.all([queue.enqueue(path.join(sourceDir, 'Dune.epub')), queue.enqueue(path.join(sourceDir, 'Dune.m4b'))]);
    const jobs = [...queue.jobs.values()];
    expect(jobs.map(j => j.type)).toEqual([JobType.FILE, JobType.FILE]);
    await vi.waitFor(() => {
      expect(jobs.every(j => j.state === JobState.COMPLETED)).toBe(true);
    }, { timeout: 5000, interval: 20 });

    expect(maxActive).toBe(1);
    expect(jobs.map(j => j.result?.outcome)).toEqual([undefined, undefined]);
    expect(await fs.readdir(destDir)).toEqual(['Frank Herbert']);
    expect(await fs.readdir(path.join(destDir, 'Frank Herbert'))).toEqual(['Dune']);
    expect((await fs.readdir(bookDir())).sort()).toEqual(['Dune.epub', 'Dune.m4b']);
    expect(await sourceLeft()).toEqual([]);
    expect(calls.error).toEqual([]);
  });
});

describe('7.4 reprocessing idempotency', () => {
  test.each(LAYOUTS)('ingesting the same files twice yields no duplicates and no overwrites (%s)', async layout => {
    process.env.LIBRARY_LAYOUT = layout;
    async function dropAll() {
      await dropDuneAudio();
      await dropDuneEpub('dune_herbert_retail.epub');
      const unitDir = path.join(sourceDir, 'Frank Herbert', 'Children of Dune');
      await writeAudio(path.join(unitDir, '01.mp3'), { title: 'Children of Dune', artist: 'Frank Herbert' }, 'track 1');
      await writeAudio(path.join(unitDir, '02.mp3'), { title: 'Children of Dune', artist: 'Frank Herbert' }, 'track 2');
      await writeEpub(path.join(unitDir, 'Children of Dune.epub'), { title: 'Children of Dune' });
    }

    await dropAll();
    await ingest();
    const tree = await snapshot(destDir);
    const times = await mtimes(destDir);
    expect(Object.keys(times)).toHaveLength(5);

    await dropAll();
    const { log, calls } = createLog();
    await ingest(log);

    expect(await snapshot(destDir)).toEqual(tree);
    expect(await mtimes(destDir)).toEqual(times);
    expect(await sourceLeft()).toEqual([]);
    expect(await fs.pathExists(reviewDir)).toBe(false);
    expect(calls.info.filter(l => l.includes('skipped identical'))).toHaveLength(5);
    expect(calls.info.some(l => l.includes('copied:'))).toBe(false);
  });
});

describe('7.5 ambiguity leaves the library untouched', () => {
  async function expectQuarantined(name, reasonPattern) {
    const before = await snapshot(destDir);
    const times = await mtimes(destDir);
    const { log, calls } = createLog();

    await ingest(log);

    expect(await snapshot(destDir)).toEqual(before);
    expect(await mtimes(destDir)).toEqual(times);
    const folders = await fs.readdir(reviewDir);
    expect(folders).toHaveLength(1);
    const folder = path.join(reviewDir, folders[0]);
    expect(await fs.pathExists(path.join(folder, name))).toBe(true);
    const review = await fs.readJson(path.join(folder, REVIEW_FILE));
    expect(review).toMatchObject({ reason: 'ambiguous', paths: [bookDir()] });
    expect(review.explanation).toMatch(reasonPattern);
    expect(await sourceLeft()).toEqual([]);
    expect(calls.warn.some(l => l.includes('Quarantined'))).toBe(true);
  }

  test('a translated EPUB lands in REVIEW_DIR and DEST_DIR is byte-for-byte unchanged', async () => {
    await writeAudio(path.join(bookDir(), 'Dune.m4b'));
    await writeEpub(path.join(bookDir(), 'Dune.epub'), { language: 'en' });
    await dropDuneEpub('Dune.epub', { language: 'de', note: 'Übersetzung' });

    await expectQuarantined('Dune.epub', /language/i);
  });

  test('a near match with AI unavailable lands in REVIEW_DIR and DEST_DIR is byte-for-byte unchanged', async () => {
    await writeAudio(path.join(bookDir(), 'Dune.m4b'));
    await writeAudio(path.join(sourceDir, 'Dune Deluxe.m4b'), { title: 'Dune: Deluxe Edition', artist: 'Frank Herbert' });

    await expectQuarantined('Dune Deluxe.m4b', /near/i);
  });
});

describe('7.6 read-aloud coexistence', () => {
  const expected = {
    audiobookshelf: { same: ['Dune (readaloud).epub', 'Dune.epub', 'Dune.m4b'], different: ['Dune.m4b', 'dune_ra.epub', 'dune_retail.epub'] },
    bookorbit: { same: ['Dune (readaloud).epub', 'Dune.epub', 'Dune.m4b'], different: ['Dune (readaloud).epub', 'Dune.epub', 'Dune.m4b'] }
  };

  test.each(LAYOUTS)('a same-named read-aloud EPUB joins the original (%s)', async layout => {
    process.env.LIBRARY_LAYOUT = layout;
    await dropDuneAudio();
    await dropDuneEpub('Dune.epub', { note: 'original' });
    await ingest();
    const original = await snapshot(bookDir());

    await dropDuneEpub('Dune.epub', { readaloud: true, note: 'read-aloud' });
    await ingest();

    expect((await fs.readdir(bookDir())).sort()).toEqual(expected[layout].same);
    expect((await snapshot(bookDir()))['Dune.epub']).toBe(original['Dune.epub']);
    expect(await fs.pathExists(reviewDir)).toBe(false);
    expect(await sourceLeft()).toEqual([]);
  });

  test('bookorbit: a same-named original arriving after the read-aloud also joins the book', async () => {
    process.env.LIBRARY_LAYOUT = 'bookorbit';
    await dropDuneAudio();
    await dropDuneEpub('Dune.epub', { readaloud: true, note: 'read-aloud' });
    await ingest();
    await dropDuneEpub('Dune.epub', { note: 'original' });
    await ingest();

    expect((await fs.readdir(bookDir())).sort()).toEqual(['Dune (readaloud).epub', 'Dune.epub', 'Dune.m4b']);
    expect(await fs.pathExists(reviewDir)).toBe(false);
  });

  // Known limitation: audiobookshelf suffixes only the read-aloud, so when the read-aloud already
  // holds the plain name a later same-named original cannot be placed. Pinned as the safe outcome.
  test('known limitation (audiobookshelf): a same-named original arriving after the read-aloud is quarantined as conflict', async () => {
    await dropDuneAudio();
    await dropDuneEpub('Dune.epub', { readaloud: true, note: 'read-aloud' });
    await ingest();
    const before = await snapshot(destDir);
    const times = await mtimes(destDir);
    const original = path.join(sourceDir, 'Dune.epub');
    await dropDuneEpub('Dune.epub', { note: 'original' });
    const originalHash = (await snapshot(sourceDir))['Dune.epub'];

    await ingest();

    expect(await snapshot(destDir)).toEqual(before);
    expect(await mtimes(destDir)).toEqual(times);
    expect(await fs.pathExists(original)).toBe(false);
    const [folder] = await fs.readdir(reviewDir);
    const review = await fs.readJson(path.join(reviewDir, folder, REVIEW_FILE));
    expect(review).toMatchObject({ reason: 'conflict', paths: [path.join(bookDir(), 'Dune.epub')] });
    // Nothing deleted: the original sits in review with its bytes intact
    expect((await snapshot(path.join(reviewDir, folder)))['Dune.epub']).toBe(originalHash);
  });

  test.each(LAYOUTS)('differently named original and read-aloud EPUBs share the book folder (%s)', async layout => {
    process.env.LIBRARY_LAYOUT = layout;
    await writeAudio(path.join(bookDir(), 'Dune.m4b'));
    await dropDuneEpub('dune_retail.epub', { note: 'original' });
    await dropDuneEpub('dune_ra.epub', { readaloud: true, note: 'read-aloud' });

    await ingest();

    expect((await fs.readdir(bookDir())).sort()).toEqual(expected[layout].different);
    expect(await fs.pathExists(reviewDir)).toBe(false);
    expect(await sourceLeft()).toEqual([]);
  });

  test.each(LAYOUTS)('a read-aloud EPUB in a directory unit with the audio joins the original (%s)', async layout => {
    process.env.LIBRARY_LAYOUT = layout;
    await writeEpub(path.join(bookDir(), 'Dune.epub'), { note: 'original' });
    const unitDir = path.join(sourceDir, 'Frank Herbert - Dune');
    await writeAudio(path.join(unitDir, 'Dune.m4b'));
    await writeEpub(path.join(unitDir, 'Dune.epub'), { readaloud: true, note: 'read-aloud' });

    await ingest();

    expect((await fs.readdir(bookDir())).sort()).toEqual(['Dune (readaloud).epub', 'Dune.epub', 'Dune.m4b']);
    expect(await fs.pathExists(unitDir)).toBe(false);
  });
});
