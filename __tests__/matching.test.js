import { describe, test, expect } from 'vitest';
import {
  authorKey, titleKey, TITLE_NOISE_WORDS, isAbridged, levenshtein, isNearTitleKey, isNearMatch
} from '../src/matching.js';

describe('matching keys', () => {
  test.each([
    ['Frank Herbert', 'frank herbert'],
    ['Herbert, Frank', 'frank herbert'],
    ['  HERBERT,   frank ', 'frank herbert'],
    ['Le Guin, Ursula K.', 'ursula k le guin'],
    ['Ursula K. Le Guin', 'ursula k le guin'],
    ['J.R.R. Tolkien', 'j r r tolkien'],
    ['Tolkien, J. R. R.', 'j r r tolkien'],
    ['Gabriel García Márquez', 'gabriel garcia marquez'],
    ['Brontë, Charlotte', 'charlotte bronte'],
    ['Brian Herbert & Kevin J. Anderson', 'brian herbert kevin j anderson'],
    ['Brian Herbert and Kevin J. Anderson', 'brian herbert kevin j anderson'],
    ['Herbert, Brian; Anderson, Kevin J.', 'brian herbert kevin j anderson'],
    // Two full names separated by a comma are not reordered
    ['Brian Herbert, Kevin J. Anderson', 'brian herbert kevin j anderson'],
    ['', '']
  ])('authorKey(%j) = %j', (input, expected) => {
    expect(authorKey(input)).toBe(expected);
  });

  test.each([
    ['Dune', 'dune'],
    ['DUNE', 'dune'],
    ['Dune (Unabridged)', 'dune'],
    ['Dune [M4B]', 'dune'],
    ['[M4B] Dune', 'dune'],
    ['Dune - Unabridged Audiobook', 'dune'],
    ['Dune (Retail)', 'dune'],
    ['Dune Retail', 'dune'],
    ['Dune (Abridged)', 'dune'],
    ['The Hobbit', 'hobbit'],
    ['A Game of Thrones', 'game of thrones'],
    ['An Unexpected Journey', 'unexpected journey'],
    ['The', 'the'],
    ['Les Misérables', 'les miserables'],
    ['Ender\'s Game', 'ender s game'],
    ['Dune: Deluxe Edition', 'dune deluxe edition'],
    ['Dune (Book 1)', 'dune book 1'],
    ['The Retail Apocalypse', 'retail apocalypse'],
    ['Audiobook', 'audiobook'],
    ['', '']
  ])('titleKey(%j) = %j', (input, expected) => {
    expect(titleKey(input)).toBe(expected);
  });

  test('equal keys despite formatting differences', () => {
    expect(authorKey('Herbert, Frank')).toBe(authorKey('Frank Herbert'));
    expect(titleKey('Dune (Unabridged)')).toBe(titleKey('Dune'));
  });

  test('noise word list is pinned', () => {
    for (const word of ['unabridged', 'audiobook', 'm4b', 'retail']) {
      expect(TITLE_NOISE_WORDS).toContain(word);
    }
    expect(TITLE_NOISE_WORDS.every(w => w === w.toLowerCase())).toBe(true);
  });
});

describe('isAbridged', () => {
  test.each([
    ['Dune (Abridged)', true],
    ['Dune [ABRIDGED].m4b', true],
    ['Dune_abridged_edition', true],
    ['Dune (Unabridged)', false],
    ['Dune UNABRIDGED.m4b', false],
    ['Dune', false],
    ['', false]
  ])('isAbridged(%j) = %j', (input, expected) => {
    expect(isAbridged(input)).toBe(expected);
  });
});

describe('near matching', () => {
  test.each([
    ['kitten', 'sitting', 3],
    ['dune', 'dune', 0],
    ['', 'abc', 3],
    ['foundation', 'foundaton', 1]
  ])('levenshtein(%j, %j) = %j', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected);
  });

  test.each([
    // Subtitle: word-boundary prefix
    ['Dune', 'Dune: Deluxe Edition', true],
    ['Dune Deluxe Edition', 'Dune', true],
    ['Dune', 'Dunes of Arrakis', false],
    // Small typos on keys of 6+ characters
    ['Foundation', 'Foundaton', true],
    ['Foundation', 'Fundatoin', false],
    ['Neuromancer', 'Nueromancer', true],
    // Short keys are never near by edit distance
    ['Dune', 'Dine', false],
    ['Emma', 'Emme', false],
    ['Hyperion', 'Hyperon', true],
    // Equal keys are an exact match, not a near match
    ['Dune (Unabridged)', 'Dune', false],
    ['Dune', '', false]
  ])('isNearTitleKey(%j, %j) = %j', (a, b, expected) => {
    expect(isNearTitleKey(titleKey(a), titleKey(b))).toBe(expected);
  });

  test('requires the same author key', () => {
    expect(isNearMatch({ author: 'Herbert, Frank', title: 'Dune' }, { author: 'Frank Herbert', title: 'Dune: Deluxe Edition' }))
      .toBe(true);
    expect(isNearMatch({ author: 'Brian Herbert', title: 'Dune' }, { author: 'Frank Herbert', title: 'Dune: Deluxe Edition' }))
      .toBe(false);
    expect(isNearMatch({ author: '', title: 'Dune' }, { author: '', title: 'Dune: Deluxe Edition' }))
      .toBe(false);
    expect(isNearMatch({ author: 'Frank Herbert', title: 'Dune' }, { author: 'Frank Herbert', title: 'Dune' }))
      .toBe(false);
  });
});
