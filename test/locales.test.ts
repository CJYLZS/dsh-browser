/**
 * Both dictionaries ship in the client bundle, and the English one is what
 * types the key set. A key present in one language only renders as its own
 * name in the other, which no build step catches.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { en, zh } from '../src/client/locales.ts'

test('both dictionaries carry exactly the same keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('no shipped string is empty', () => {
  for (const [key, value] of [...Object.entries(en), ...Object.entries(zh)]) {
    assert.notEqual(value.trim(), '', `${key} is empty`)
  }
})

test('a placeholder in one language exists in the other', () => {
  const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '')
  for (const [key, english] of Object.entries(en)) {
    const chinese = (zh as Record<string, string>)[key] ?? ''
    assert.deepEqual(
      placeholders(chinese).sort(),
      placeholders(english).sort(),
      `${key} disagrees about placeholders`,
    )
  }
})
