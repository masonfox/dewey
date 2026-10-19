import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Library file metadata is keyed by basename; AI is mocked per test
const epubMeta = {};
const audioMeta = {};
vi.mock('../src/metadata.js', () => ({
  extractEpubMetadata: vi.fn(async (p) => epubMeta[path.basename(p)] ?? null),
  extractAudioMetadata: vi.fn(async (p) => audioMeta[path.basename(p)] ?? null)
}));
vi.mock('../src/ai.js', () => ({
  resolveMatchViaAI: vi.fn()
}));

const { findCandidates, resolveMatch, languageKey } = await import('../src/matching.js');
const { extractEpubMetadata, extractAudioMetadata } = await import('../src/metadata.js');
const { resolveMatchViaAI } = await import('../src/ai.js');

function createMockLogger() {
  const calls = { info: [], warn: [], debug: [], error: [] };
  return {
    log: {
      info: (...args) => calls.info.push(args.join(' ')),
      warn: (...args) => calls.warn.push(args.join(' ')),
      debug: (...args) => calls.debug.push(args.join(' ')),
      error: (...args) => calls.error.push(args.join(' '))
    },
    calls
  };
}

const isbn = (value) => ({ type: 'isbn', value, scheme: 'isbn' });
const asin = (value) => ({ type: 'asin', value, scheme: 'asin' });
const ISBN_A = '9780441013593';
const ISBN_B = '9780593099322';
const ISBN_DE = '9783453317178';

function epub({ title = 'Dune', author = 'Frank Herbert', language = 'en', identifiers = [], readaloud = false } = {}) {
  return { title, author, language, identifiers, readaloud, hasMetadata: true, source: 'epub' };
}

/** Unit as migrate builds it: resolved author/title plus extractUnitMetadata-style files */
function unit({ author = 'Frank Herbert', title = 'Dune', displayName, files = [], language = null, identifiers = [] } = {}) {
  return {
    author,
    title,
    displayName: displayName ?? files[0]?.path ?? title,
    files: files.map(f => ({ readaloud: false, metadata: null, ...f })),
    metadata: { title, author, language, identifiers }
  };
}

let destDir;
let savedDest;

async function place(relPath, content = 'x') {
  const full = path.join(destDir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

async function match(u) {
  const { log, calls } = createMockLogger();
  const candidates = await findCandidates(u, log);
  const decision = await resolveMatch(u, candidates, log);
  return { decision, candidates, calls };
}

beforeEach(async () => {
  savedDest = process.env.DEST_DIR;
  destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-match-'));
  process.env.DEST_DIR = destDir;
  for (const k of Object.keys(epubMeta)) delete epubMeta[k];
  for (const k of Object.keys(audioMeta)) delete audioMeta[k];
  vi.clearAllMocks();
  resolveMatchViaAI.mockResolvedValue({ matched: null, index: null, distinct: false, reason: 'AI unavailable' });
});

afterEach(async () => {
  if (savedDest === undefined) delete process.env.DEST_DIR; else process.env.DEST_DIR = savedDest;
  await fs.rm(destDir, { recursive: true, force: true });
});

describe('findCandidates', () => {
  test('returns only same-author-key book folders containing supported files', async () => {
    await place('Frank Herbert/Dune/Dune.m4b');
    await place('Herbert, Frank/Children of Dune/Children of Dune.epub');
    await place('Frank Herbert/Notes/readme.txt');           // no supported file
    await place('Frank Herbert/Empty/.dewey-partial-x-a.m4b'); // dotfiles ignored
    await place('Frank Herbert/.hidden/Dune.m4b');            // dot folders ignored
    await place('Frank Herbert/cover.jpg');
    await place('Brian Herbert/Dune/Dune.m4b');               // different author key
    await place('Isaac Asimov/Foundation/Foundation.epub');

    const { log } = createMockLogger();
    const candidates = await findCandidates({ author: 'Frank Herbert', title: 'Dune' }, log);

    expect(candidates.map(c => c.folder).sort()).toEqual(['Frank Herbert/Dune', 'Herbert, Frank/Children of Dune']);
    const dune = candidates.find(c => c.folder === 'Frank Herbert/Dune');
    expect(dune).toMatchObject({
      author: 'Frank Herbert', title: 'Dune', relation: 'equal', formats: ['audio'],
      path: path.join(destDir, 'Frank Herbert', 'Dune')
    });
    expect(dune.files.map(f => f.name)).toEqual(['Dune.m4b']);
  });

  test('a missing DEST_DIR yields no candidates', async () => {
    process.env.DEST_DIR = path.join(destDir, 'missing');
    const { log } = createMockLogger();
    expect(await findCandidates({ author: 'Frank Herbert', title: 'Dune' }, log)).toEqual([]);
  });

  test('reads the library fresh on every call', async () => {
    const { log } = createMockLogger();
    const u = { author: 'Frank Herbert', title: 'Dune' };
    expect(await findCandidates(u, log)).toEqual([]);
    await place('Frank Herbert/Dune/Dune.epub');
    expect((await findCandidates(u, log)).map(c => c.folder)).toEqual(['Frank Herbert/Dune']);
  });

  test('loads details only for equal or near titles, probing one audio file', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    await place('Frank Herbert/Dune/Dune.m4b');
    await place('Frank Herbert/Dune/Dune - Part 2.mp3');
    await place('Frank Herbert/Dune Messiah/Dune Messiah.epub');
    await place('Frank Herbert/The Dosadi Experiment/Dosadi.epub');
    epubMeta['Dune.epub'] = epub({ identifiers: [isbn(ISBN_A), { type: 'other', value: 'urn:uuid:1', scheme: 'uuid' }] });
    audioMeta['Dune.m4b'] = { title: 'Dune', author: 'Frank Herbert', language: 'eng', asin: 'B002V1OF70' };

    const { log } = createMockLogger();
    const candidates = await findCandidates({ author: 'Frank Herbert', title: 'Dune' }, log);
    const byFolder = Object.fromEntries(candidates.map(c => [c.title, c]));

    expect(byFolder['Dune']).toMatchObject({
      relation: 'equal', detailed: true, editionIsbns: [ISBN_A], languages: ['en'], language: 'en', abridged: false,
      identifiers: [isbn(ISBN_A), asin('B002V1OF70')]
    });
    expect(byFolder['Dune Messiah']).toMatchObject({ relation: 'near', detailed: true });
    expect(byFolder['The Dosadi Experiment']).toMatchObject({ relation: 'unrelated', detailed: false });

    const probed = [...extractEpubMetadata.mock.calls, ...extractAudioMetadata.mock.calls].map(c => path.basename(c[0]));
    expect(probed.sort()).toEqual(['Dune Messiah.epub', 'Dune.epub', 'Dune.m4b']);
  });

  test('marks abridged candidates from folder or file names', async () => {
    await place('Frank Herbert/Dune (Abridged)/Dune.m4b');
    const { log } = createMockLogger();
    const [candidate] = await findCandidates({ author: 'Frank Herbert', title: 'Dune' }, log);
    expect(candidate).toMatchObject({ relation: 'equal', abridged: true });
  });

  test('finds folders written by sanitizeSegment for names with diacritics', async () => {
    // sanitizeSegment('Frédéric Brontë') === 'Fr d ric Bront'
    await place('Fr d ric Bront/L t trange/L t trange.m4b');
    const u = unit({ author: 'Frédéric Brontë', title: "L'Été Étrange", files: [{ path: '/in/ete.epub', kind: 'epub' }] });
    const { decision, candidates } = await match(u);
    expect(candidates.map(c => [c.folder, c.relation])).toEqual([['Fr d ric Bront/L t trange', 'equal']]);
    expect(decision).toMatchObject({ outcome: 'deterministic', candidate: { folder: 'Fr d ric Bront/L t trange' } });
  });
});

describe('resolveMatch (cross-format-matching spec)', () => {
  test('book already in library: existing Dune folder is a candidate and matches', async () => {
    await place('Frank Herbert/Dune/Dune.m4b');
    const u = unit({ files: [{ path: '/in/Dune.epub', kind: 'epub', metadata: epub() }], language: 'en' });
    const { decision, candidates } = await match(u);
    expect(candidates.map(c => c.folder)).toEqual(['Frank Herbert/Dune']);
    expect(decision).toMatchObject({ outcome: 'deterministic', candidate: { folder: 'Frank Herbert/Dune' } });
  });

  test('read-aloud EPUB sharing the original ISBN matches by identifier', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    epubMeta['Dune.epub'] = epub({ identifiers: [isbn(ISBN_A)] });
    // Title differs enough that only the identifier can decide
    const u = unit({
      title: 'Dune Read Along',
      files: [{ path: '/in/Dune (readaloud).epub', kind: 'epub', readaloud: true,
        metadata: epub({ readaloud: true, identifiers: [isbn(ISBN_A)] }) }],
      identifiers: [isbn(ISBN_A)]
    });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'identifier', candidate: { folder: 'Frank Herbert/Dune' }, signal: `isbn:${ISBN_A}` });
    expect(resolveMatchViaAI).not.toHaveBeenCalled();
  });

  test('identifier match wins over multiple equal candidates', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    await place('Herbert, Frank/Dune/Dune.m4b');
    audioMeta['Dune.m4b'] = { title: 'Dune', asin: 'B002V1OF70' };
    const u = unit({ files: [{ path: '/in/Dune.m4b', kind: 'audio', metadata: { asin: 'B002V1OF70' } }] });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'identifier', candidate: { folder: 'Herbert, Frank/Dune' } });
  });

  test('an identifier held by several library books is ambiguous', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    await place('Herbert, Frank/Dune/Dune.epub');
    epubMeta['Dune.epub'] = epub({ identifiers: [isbn(ISBN_A)] });
    const u = unit({ identifiers: [isbn(ISBN_A)], files: [{ path: '/in/Dune.m4b', kind: 'audio' }] });
    const { decision } = await match(u);
    expect(decision.outcome).toBe('ambiguous');
    expect(decision.candidates).toHaveLength(2);
  });

  test('different identifiers across formats do not block a match', async () => {
    await place('Frank Herbert/Dune/Dune.m4b');
    audioMeta['Dune.m4b'] = { title: 'Dune', asin: 'B002V1OF70', isbn: ISBN_B };
    const u = unit({
      files: [{ path: '/in/Dune.epub', kind: 'epub', metadata: epub({ identifiers: [isbn(ISBN_A)] }) }],
      identifiers: [isbn(ISBN_A)]
    });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'deterministic', candidate: { folder: 'Frank Herbert/Dune' } });
  });

  test('different ebook edition (non-read-aloud EPUB ISBNs differ) is ambiguous', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    epubMeta['Dune.epub'] = epub({ identifiers: [isbn(ISBN_B)] });
    const u = unit({
      files: [{ path: '/in/Dune.epub', kind: 'epub', metadata: epub({ identifiers: [isbn(ISBN_A)] }) }],
      identifiers: [isbn(ISBN_A)]
    });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'ambiguous', candidate: null });
    expect(decision.signal).toContain(ISBN_A);
    expect(decision.signal).toContain(ISBN_B);
  });

  test('a read-aloud EPUB in the library does not count as a different ebook edition', async () => {
    await place('Frank Herbert/Dune/Dune (readaloud).epub');
    epubMeta['Dune (readaloud).epub'] = epub({ readaloud: true, identifiers: [isbn(ISBN_B)] });
    const u = unit({
      files: [{ path: '/in/Dune.epub', kind: 'epub', metadata: epub({ identifiers: [isbn(ISBN_A)] }) }],
      identifiers: [isbn(ISBN_A)]
    });
    const { decision } = await match(u);
    expect(decision.outcome).toBe('deterministic');
  });

  test('equal keys despite formatting differences match without AI', async () => {
    await place('Herbert, Frank/Dune (Unabridged)/Dune.m4b');
    const u = unit({ files: [{ path: '/in/Dune.epub', kind: 'epub', metadata: epub() }] });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'deterministic', candidate: { folder: 'Herbert, Frank/Dune (Unabridged)' } });
    expect(resolveMatchViaAI).not.toHaveBeenCalled();
  });

  test('no related book: unit becomes a new book', async () => {
    await place('Isaac Asimov/Foundation/Foundation.epub');
    await place('Frank Herbert/The Dosadi Experiment/Dosadi.epub');
    const u = unit({ files: [{ path: '/in/Dune.epub', kind: 'epub' }] });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'new', candidate: null, candidates: [] });
    expect(resolveMatchViaAI).not.toHaveBeenCalled();
  });

  test('abridged audiobook against an unabridged EPUB is ambiguous', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    epubMeta['Dune.epub'] = epub();
    const u = unit({ title: 'Dune (Abridged)', displayName: 'Dune (Abridged).m4b',
      files: [{ path: '/in/Dune (Abridged).m4b', kind: 'audio' }] });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'ambiguous', candidate: null, candidates: [{ folder: 'Frank Herbert/Dune' }] });
    expect(decision.signal).toMatch(/abridged/);
  });

  test('translation (known, different languages) is ambiguous', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    epubMeta['Dune.epub'] = epub({ language: 'en' });
    const u = unit({ language: 'de', files: [{ path: '/in/Dune.epub', kind: 'epub', metadata: epub({ language: 'de' }) }] });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'ambiguous', signal: 'language de != en' });
  });

  test('language region and ISO 639-2 variants are the same language', async () => {
    expect(languageKey('en-US')).toBe('en');
    expect(languageKey('eng')).toBe('en');
    expect(languageKey('und')).toBeNull();
    await place('Frank Herbert/Dune/Dune.m4b');
    audioMeta['Dune.m4b'] = { title: 'Dune', language: 'eng' };
    const u = unit({ language: 'en-US', files: [{ path: '/in/Dune.epub', kind: 'epub' }] });
    expect((await match(u)).decision.outcome).toBe('deterministic');
  });

  test('two equal candidates are ambiguous', async () => {
    await place('Frank Herbert/Dune/Dune.m4b');
    await place('Frank Herbert/Dune [M4B]/Dune.m4b');
    const u = unit({ files: [{ path: '/in/Dune.epub', kind: 'epub' }] });
    const { decision } = await match(u);
    expect(decision.outcome).toBe('ambiguous');
    expect(decision.candidates.map(c => c.folder).sort()).toEqual(['Frank Herbert/Dune', 'Frank Herbert/Dune [M4B]']);
    expect(resolveMatchViaAI).not.toHaveBeenCalled();
  });

  test('AI confirms a subtitle variant: placed in the existing folder', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    resolveMatchViaAI.mockImplementation(async (aiUnit, listed) =>
      ({ matched: listed[0], index: 0, distinct: false, reason: 'AI confirmed same edition with high confidence' }));
    const u = unit({ title: 'Dune: Deluxe Edition', files: [{ path: '/in/Dune Deluxe.m4b', kind: 'audio' }] });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'ai', candidate: { folder: 'Frank Herbert/Dune' } });
    const [aiUnit, listed] = resolveMatchViaAI.mock.calls[0];
    expect(aiUnit).toMatchObject({ formats: ['audio'], metadata: { title: 'Dune: Deluxe Edition', author: 'Frank Herbert' } });
    expect(listed.map(c => c.folder)).toEqual(['Frank Herbert/Dune']);
  });

  test('an AI-confirmed candidate is still blocked by an edition conflict', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    epubMeta['Dune.epub'] = epub({ language: 'en' });
    resolveMatchViaAI.mockImplementation(async (aiUnit, listed) =>
      ({ matched: listed[0], index: 0, distinct: false, reason: 'AI confirmed same edition with high confidence' }));
    const u = unit({ title: 'Dune: Deluxe Edition', language: 'fr', files: [{ path: '/in/x.m4b', kind: 'audio' }] });
    expect((await match(u)).decision).toMatchObject({ outcome: 'ambiguous', signal: 'language fr != en' });
  });

  test('AI rules out a sequel: unit becomes a new book', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    resolveMatchViaAI.mockResolvedValue({ matched: null, index: null, distinct: true, reason: 'AI ruled out every candidate with high confidence' });
    const u = unit({ title: 'Dune Messiah', files: [{ path: '/in/Dune Messiah.m4b', kind: 'audio' }] });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'new', candidate: null, candidates: [{ folder: 'Frank Herbert/Dune' }] });
  });

  test.each([
    ['AI unavailable'],
    ['AI confidence medium'],
    ['AI reported a different edition'],
    ['AI request failed (timeout)']
  ])('near match left unconfirmed (%s) is ambiguous', async (reason) => {
    await place('Frank Herbert/Dune/Dune.epub');
    resolveMatchViaAI.mockResolvedValue({ matched: null, index: null, distinct: false, reason });
    const u = unit({ title: 'Dune: Deluxe Edition', files: [{ path: '/in/x.m4b', kind: 'audio' }] });
    const { decision } = await match(u);
    expect(decision).toMatchObject({ outcome: 'ambiguous', candidate: null, reason });
  });

  test('AI receives at most five near candidates, closest first', async () => {
    for (const t of ['Dune', 'Dune Saga Book 1', 'Dune Saga Book 2', 'Dune Saga Book 3', 'Dune Saga Book 4', 'Dune Saga Book 5', 'Dune Saga Book 6']) {
      await place(`Frank Herbert/${t}/${t}.epub`);
    }
    const u = unit({ title: 'Dune Saga', files: [{ path: '/in/x.m4b', kind: 'audio' }] });
    await match(u);
    const listed = resolveMatchViaAI.mock.calls[0][1];
    expect(listed).toHaveLength(5);
    expect(listed[0].folder).toBe('Frank Herbert/Dune');
  });

  test('EPUB first, then audiobook: the audiobook joins the EPUB folder', async () => {
    const first = await match(unit({ files: [{ path: '/in/Dune.epub', kind: 'epub' }] }));
    expect(first.decision.outcome).toBe('new');
    await place('Frank Herbert/Dune/Dune.epub'); // placed by migrate
    const second = await match(unit({ files: [{ path: '/in/Dune.m4b', kind: 'audio' }] }));
    expect(second.decision).toMatchObject({ outcome: 'deterministic', candidate: { folder: 'Frank Herbert/Dune' } });
  });

  test('audiobook first, then EPUB: the EPUB joins the audiobook folder', async () => {
    const first = await match(unit({ files: [{ path: '/in/Dune.m4b', kind: 'audio' }] }));
    expect(first.decision.outcome).toBe('new');
    await place('Frank Herbert/Dune/Dune.m4b');
    const second = await match(unit({ files: [{ path: '/in/Dune.epub', kind: 'epub' }] }));
    expect(second.decision).toMatchObject({ outcome: 'deterministic', candidate: { folder: 'Frank Herbert/Dune' } });
  });

  test('simultaneous arrival decided serially: the second unit sees the first placement', async () => {
    const epubUnit = unit({ files: [{ path: '/in/Dune.epub', kind: 'epub' }] });
    const audioUnit = unit({ files: [{ path: '/in/Dune.m4b', kind: 'audio' }] });
    expect((await match(epubUnit)).decision.outcome).toBe('new');
    await place('Frank Herbert/Dune/Dune.epub');
    expect((await match(audioUnit)).decision.candidate.folder).toBe('Frank Herbert/Dune');
  });
});

describe('match decision logging', () => {
  test('logs one info line for a deterministic match naming the destination folder', async () => {
    await place('Frank Herbert/Dune/Dune.m4b');
    const { calls } = await match(unit({ displayName: 'Dune.epub', files: [{ path: '/in/Dune.epub', kind: 'epub' }] }));
    expect(calls.info).toHaveLength(1);
    expect(calls.info[0]).toMatch(/deterministic match/);
    expect(calls.info[0]).toContain('Frank Herbert/Dune');
    expect(calls.info[0]).toContain('signal: equal author/title keys');
  });

  test('ambiguous line names the candidates and the conflicting language', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    epubMeta['Dune.epub'] = epub({ language: 'en' });
    const { calls } = await match(unit({ language: 'de', files: [{ path: '/in/Dune.epub', kind: 'epub' }] }));
    expect(calls.info).toEqual([expect.stringMatching(/ambiguous.*candidates Frank Herbert\/Dune.*language de != en/)]);
  });

  test('identifier line names the shared identifier', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    epubMeta['Dune.epub'] = epub({ identifiers: [isbn(ISBN_A)] });
    const { calls } = await match(unit({ title: 'Dune Read Along', identifiers: [isbn(ISBN_A)], files: [] }));
    expect(calls.info).toEqual([expect.stringMatching(new RegExp(`identifier match.*Frank Herbert/Dune.*isbn:${ISBN_A}`))]);
  });

  test('AI path still logs a single info line, demoting the AI module info line', async () => {
    await place('Frank Herbert/Dune/Dune.epub');
    resolveMatchViaAI.mockImplementation(async (aiUnit, listed, log) => {
      log.info('AI anthropic match resolution: AI ruled out every candidate with high confidence');
      return { matched: null, index: null, distinct: true, reason: 'AI ruled out every candidate with high confidence' };
    });
    const { calls } = await match(unit({ title: 'Dune Messiah', files: [{ path: '/in/x.m4b', kind: 'audio' }] }));
    expect(calls.info).toHaveLength(1);
    expect(calls.info[0]).toMatch(/new book.*candidates Frank Herbert\/Dune.*AI ruled out/);
    expect(calls.debug.some(l => l.includes('AI anthropic match resolution'))).toBe(true);
  });

  test('new-book line with no candidates', async () => {
    const { calls } = await match(unit({ files: [{ path: '/in/Dune.epub', kind: 'epub' }] }));
    expect(calls.info).toEqual([expect.stringMatching(/new book.*no candidates/)]);
  });
});
