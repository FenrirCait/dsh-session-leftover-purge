// The settings card is a hand-written client bundle with no build step, so its
// dictionaries are checked statically: every key used must exist in both
// languages, and the card's copy of the defaults must match the server schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { DEFAULTS } from '../lib/config.js';

const CLIENT = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Slice a `const NAME = { … };` object literal out of the bundle text. */
function objectLiteral(name) {
  const start = CLIENT.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `${name} not found in client.js`);
  let depth = 0;
  for (let index = start; index < CLIENT.length; index += 1) {
    const ch = CLIENT[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return CLIENT.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

function keysOf(literal) {
  return new Set([...literal.matchAll(/"([a-zA-Z][\w.]*)":/g)].map((match) => match[1]));
}

const zh = keysOf(objectLiteral('ZH'));
const en = keysOf(objectLiteral('EN'));

test('both dictionaries carry the same keys', () => {
  const missingInEn = [...zh].filter((key) => !en.has(key));
  const missingInZh = [...en].filter((key) => !zh.has(key));
  assert.deepEqual(missingInEn, [], `missing in EN: ${missingInEn.join(', ')}`);
  assert.deepEqual(missingInZh, [], `missing in ZH: ${missingInZh.join(', ')}`);
  assert.ok(zh.size >= 40, `expected the full card dictionary, got ${zh.size} keys`);
});

test('every translation key the card reaches resolves', () => {
  // Literal t("…") calls plus the field tables' labelKey/hintKey references —
  // the card resolves those dynamically, so a bare t("…") scan is not enough.
  const literal = [...CLIENT.matchAll(/\bt\("([\w.]+)"\)/g)].map((match) => match[1]);
  const fieldKeys = [...CLIENT.matchAll(/labelKey: "([\w.]+)", hintKey: "([\w.]+)"/g)].flatMap((match) => [match[1], match[2]]);
  const used = new Set([...literal, ...fieldKeys]);
  assert.ok(used.size > 30, `expected the card to translate its labels, got ${used.size}`);
  const missing = [...used].filter((key) => !zh.has(key) || !en.has(key));
  assert.deepEqual(missing, [], `untranslated: ${missing.join(', ')}`);
});

test('the card default table matches the server schema defaults', () => {
  const literal = objectLiteral('DEFAULTS');
  const clientDefaults = {};
  for (const match of literal.matchAll(/(\w+):\s*(true|false|-?\d+|[a-z]+)/g)) {
    const value = match[2];
    clientDefaults[match[1]] = value === 'true' ? true : value === 'false' ? false : Number(value);
  }
  assert.deepEqual(Object.keys(clientDefaults).sort(), Object.keys(DEFAULTS).sort());
  for (const key of Object.keys(DEFAULTS)) {
    assert.equal(clientDefaults[key], DEFAULTS[key], `default mismatch for ${key}`);
  }
});

test('the locale files point at the right readme', () => {
  const zhMeta = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'));
  const enMeta = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'));
  assert.equal(zhMeta.meta.detail, 'README.md');
  assert.equal(enMeta.meta.detail, 'README.en.md');
  assert.ok(zhMeta.meta.title.length > 0 && enMeta.meta.title.length > 0);
  assert.notEqual(zhMeta.meta.description, enMeta.meta.description);
});
