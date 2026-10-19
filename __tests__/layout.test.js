import { describe, test, expect, afterEach } from 'vitest';
import path from 'node:path';
import { audiobookshelf, bookorbit, getLayout } from '../src/layout.js';
import { validateConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const dest = path.join('/library');
const audio = name => ({ path: `/incoming/${name}`, kind: 'audio', readaloud: false });
const epub = name => ({ path: `/incoming/${name}`, kind: 'epub', readaloud: false });
const readaloud = name => ({ path: `/incoming/sub/${name}`, kind: 'epub', readaloud: true });

describe('layout', () => {
  afterEach(() => {
    delete process.env.LIBRARY_LAYOUT;
  });

  describe('strategy selection', () => {
    test('unset layout uses audiobookshelf', () => {
      delete process.env.LIBRARY_LAYOUT;
      expect(getLayout()).toBe(audiobookshelf);
    });

    test('blank layout uses audiobookshelf', () => {
      process.env.LIBRARY_LAYOUT = '  ';
      expect(getLayout()).toBe(audiobookshelf);
    });

    test('values are compared case-insensitively', () => {
      process.env.LIBRARY_LAYOUT = 'BookOrbit';
      expect(getLayout()).toBe(bookorbit);
      process.env.LIBRARY_LAYOUT = 'AUDIOBOOKSHELF';
      expect(getLayout()).toBe(audiobookshelf);
      expect(getLayout('bookorbit').name).toBe('bookorbit');
    });

    test('invalid layout fails naming LIBRARY_LAYOUT', () => {
      process.env.LIBRARY_LAYOUT = 'calibre';
      expect(() => getLayout()).toThrow(ConfigError);
      expect(() => getLayout()).toThrow(/LIBRARY_LAYOUT/);
      expect(() => validateConfig()).toThrow(/LIBRARY_LAYOUT/);
    });
  });

  describe.each([audiobookshelf, bookorbit])('$name book folder placement', layout => {
    test('all formats are direct children of DEST_DIR/Author/Title', () => {
      const bookDir = layout.bookDir(dest, 'Frank Herbert', 'Dune');
      expect(bookDir).toBe(path.join(dest, 'Frank Herbert', 'Dune'));
      const names = [];
      for (const file of [audio('Dune.m4b'), epub('dune_herbert_retail.epub'), readaloud('dune_herbert_retail.epub')]) {
        names.push(layout.fileName(file, { title: 'Dune', existingNames: names }));
      }
      for (const name of names) {
        expect(path.dirname(path.join(bookDir, name))).toBe(bookDir);
      }
      expect(new Set(names.map(n => n.toLowerCase())).size).toBe(3);
    });

    test('new folder names use the existing sanitization', () => {
      expect(layout.bookDir(dest, 'Herbert, Frank', 'Dune: Messiah!'))
        .toBe(path.join(dest, 'Herbert Frank', 'Dune Messiah'));
      expect(layout.bookDir(dest, '', '')).toBe(path.join(dest, 'Unknown', 'Unknown'));
    });
  });

  describe('audiobookshelf naming', () => {
    test('original names kept', () => {
      expect(audiobookshelf.fileName(epub('dune_herbert_retail.epub'), { title: 'Dune', existingNames: [] }))
        .toBe('dune_herbert_retail.epub');
      expect(audiobookshelf.fileName(audio('01 - Chapter One.mp3'), { title: 'Dune', existingNames: [] }))
        .toBe('01 - Chapter One.mp3');
      expect(audiobookshelf.fileName({ name: 'Dune.epub', kind: 'epub', readaloud: true }, { title: 'Dune' }))
        .toBe('Dune.epub');
    });

    test('read-aloud EPUB sharing the original name gets the suffix', () => {
      expect(audiobookshelf.fileName(readaloud('Dune.epub'), { title: 'Dune', existingNames: ['Dune.m4b', 'Dune.epub'] }))
        .toBe('Dune (readaloud).epub');
      expect(audiobookshelf.fileName(readaloud('Dune.EPUB'), { title: 'Dune', existingNames: new Set(['dune.epub']) }))
        .toBe('Dune (readaloud).EPUB');
    });

    test('a same-named existing read-aloud EPUB is not a collision with the original', () => {
      expect(audiobookshelf.fileName(readaloud('Dune.epub'), {
        title: 'Dune', existingNames: ['Dune.epub'], readaloudNames: ['Dune.epub']
      })).toBe('Dune.epub');
    });

    test('only read-aloud EPUBs are renamed', () => {
      expect(audiobookshelf.fileName(epub('Dune.epub'), { title: 'Dune', existingNames: ['Dune.epub'] }))
        .toBe('Dune.epub');
      expect(audiobookshelf.fileName(audio('Dune.m4b'), { title: 'Dune', existingNames: ['Dune.m4b'] }))
        .toBe('Dune.m4b');
    });
  });

  describe('bookorbit naming', () => {
    test('canonical ebook names, audio names unchanged', () => {
      const context = { title: 'Dune', existingNames: [] };
      expect(bookorbit.fileName(epub('dune_herbert_retail.epub'), context)).toBe('Dune.epub');
      expect(bookorbit.fileName(readaloud('dune_herbert_retail.epub'), context)).toBe('Dune (readaloud).epub');
      expect(bookorbit.fileName(audio('Dune [Unabridged].m4b'), context)).toBe('Dune [Unabridged].m4b');
      expect(bookorbit.fileName({ name: '01.mp3', kind: 'audio', readaloud: false }, context)).toBe('01.mp3');
    });

    test('uses the book folder title segment as given', () => {
      expect(bookorbit.fileName(epub('x.epub'), { title: 'Dune Messiah' })).toBe('Dune Messiah.epub');
    });
  });

  describe('layout independence', () => {
    test('switching layout only changes names of newly placed ebooks', () => {
      const existing = ['dune_herbert_retail.epub', 'Dune.m4b'];
      const bookDir = path.join(dest, 'Frank Herbert', 'Dune');
      process.env.LIBRARY_LAYOUT = 'audiobookshelf';
      const before = getLayout();
      process.env.LIBRARY_LAYOUT = 'bookorbit';
      const after = getLayout();

      // Same folder for the same resolved book; existing files are never inputs to renaming
      expect(after.bookDir(dest, 'Frank Herbert', 'Dune')).toBe(before.bookDir(dest, 'Frank Herbert', 'Dune'));
      expect(after.bookDir(dest, 'Frank Herbert', 'Dune')).toBe(bookDir);
      expect(after.fileName(readaloud('dune_herbert_retail.epub'), { title: 'Dune', existingNames: existing }))
        .toBe('Dune (readaloud).epub');
      expect(after.fileName(audio('Dune.m4b'), { title: 'Dune', existingNames: existing })).toBe('Dune.m4b');
      expect(existing).toEqual(['dune_herbert_retail.epub', 'Dune.m4b']);
    });

    test('strategies are pure: the same inputs give the same names', () => {
      const file = readaloud('Dune.epub');
      const context = { title: 'Dune', existingNames: ['Dune.epub'] };
      expect(audiobookshelf.fileName(file, context)).toBe(audiobookshelf.fileName(file, context));
      expect(file).toEqual(readaloud('Dune.epub'));
    });
  });
});
