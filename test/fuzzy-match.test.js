const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fuzzyMatch } = require('../src/rooms');

// submitBonusGuess() runs each of a player's typed artist/title guesses
// through fuzzyMatch() against the actual card. It must stay lenient
// enough for real typos/punctuation/casing, but not so lenient that a
// trivial fragment (a single shared letter) auto-matches anything.

test('exact match (case/accent/punctuation-insensitive) always matches', () => {
  assert.equal(fuzzyMatch('Dancing Queen', 'Dancing Queen'), true);
  assert.equal(fuzzyMatch('dancing queen', 'Dancing Queen'), true);
  assert.equal(fuzzyMatch('Café', 'Cafe'), true);
  assert.equal(fuzzyMatch("Rock'n'Roll!", 'Rock n Roll'), true);
});

test('real one- and two-character artist/title names still match exactly', () => {
  assert.equal(fuzzyMatch('M', 'M'), true);
  assert.equal(fuzzyMatch('m', 'M'), true);
  assert.equal(fuzzyMatch('U2', 'U2'), true);
  assert.equal(fuzzyMatch('u2', 'U2'), true);
});

test('a one- or two-character fragment does not auto-match a longer answer', () => {
  // The reported bug: any string containing "a" (almost everything)
  // used to match "ABBA" or "Dancing Queen" outright.
  assert.equal(fuzzyMatch('a', 'ABBA'), false);
  assert.equal(fuzzyMatch('a', 'Dancing Queen'), false);
  assert.equal(fuzzyMatch('an', 'Dancing Queen'), false);
});

test('a genuine multi-character partial word still matches via containment', () => {
  assert.equal(fuzzyMatch('Rhapsody', 'Bohemian Rhapsody'), true);
  assert.equal(fuzzyMatch('Bohemian Rhapsody', 'Bohemian Rhapsody (Remastered 2011)'), true);
});

test('an unrelated string does not match just because it contains the answer', () => {
  assert.equal(fuzzyMatch('a', 'M'), false); // "M" as the ACTUAL answer, tiny unrelated guess
  assert.equal(fuzzyMatch('xyz', 'M'), false);
});

test('small typos within Levenshtein tolerance still match', () => {
  assert.equal(fuzzyMatch('Dancng Queen', 'Dancing Queen'), true); // one missing letter
  assert.equal(fuzzyMatch('Dancing Qeen', 'Dancing Queen'), true);
});

test('a clearly wrong guess of similar length does not match', () => {
  assert.equal(fuzzyMatch('Purple Rain', 'Dancing Queen'), false);
});

test('empty or missing guesses never match', () => {
  assert.equal(fuzzyMatch('', 'Dancing Queen'), false);
  assert.equal(fuzzyMatch('   ', 'Dancing Queen'), false);
});
