import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import chokidar from 'chokidar';
import { isWithinReviewDir } from '../src/utils.js';

// src/index.js starts the app on import, so this exercises the same predicate it passes as chokidar's `ignored`
describe('watcher review directory ignore predicate', () => {
  let testDir;
  let sourceDir;
  let savedReviewDir;
  let savedSourceDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-watcher-test-'));
    sourceDir = path.join(testDir, 'incoming');
    savedReviewDir = process.env.REVIEW_DIR;
    savedSourceDir = process.env.SOURCE_DIR;
    delete process.env.REVIEW_DIR;
    process.env.SOURCE_DIR = sourceDir;
  });

  afterEach(async () => {
    if (savedReviewDir === undefined) delete process.env.REVIEW_DIR;
    else process.env.REVIEW_DIR = savedReviewDir;
    if (savedSourceDir === undefined) delete process.env.SOURCE_DIR;
    else process.env.SOURCE_DIR = savedSourceDir;
    await fs.remove(testDir);
  });

  test('chokidar emits nothing under the default REVIEW_DIR but still sees siblings', async () => {
    await fs.outputFile(path.join(sourceDir, '.dewey-review', 'unit', 'Dune.epub'), 'epub');
    await fs.outputFile(path.join(sourceDir, '.dewey-review2', 'Other.epub'), 'epub');
    await fs.outputFile(path.join(sourceDir, 'Dune', 'Dune.m4b'), 'audio');

    const seen = [];
    const watcher = chokidar.watch(sourceDir, { ignoreInitial: false, depth: 3, ignored: (p) => isWithinReviewDir(p) });
    watcher.on('add', p => seen.push(p)).on('addDir', p => seen.push(p));
    await new Promise(resolve => watcher.on('ready', resolve));
    await watcher.close();

    const rel = seen.map(p => path.relative(sourceDir, p));
    expect(rel).toEqual(expect.arrayContaining([
      path.join('.dewey-review2', 'Other.epub'),
      path.join('Dune', 'Dune.m4b')
    ]));
    expect(rel.some(r => r.startsWith('.dewey-review' + path.sep) || r === '.dewey-review')).toBe(false);
  });
});
