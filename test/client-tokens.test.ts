/**
 * The custom properties the client half styles with.
 *
 * Both halves of this plugin draw with inline styles, so a token name is the
 * only thing between a theme and a colour. A name the theme does not define
 * leaves the declaration invalid — and while a fallback sits beside it, the
 * fallback is what renders: the settings page asked for `--dsh-input-background`
 * with a dark literal behind it, so `page.json`-less profiles looked right in
 * dark and came out black on black in light. Every name below is a `--dsw-*`
 * token from the harness theme (`packages/client/ui-theme/src/styles`), and this
 * list is two-way: a new name is a deliberate edit here, and a name the styles
 * stop using is an entry to delete.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'

/** Theme tokens the client half may reference, sorted. */
const ALLOWED = [
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l4',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-settings-card-fill',
  '--dsw-alias-settings-card-stroke',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-warn-label',
  '--dsw-radius-md',
  '--dsw-radius-sm',
  '--dsw-radius-xl',
] as const

/** Where the browser half's source lives. */
const SOURCE = 'src/client'

/**
 * Every source file under the browser half.
 * @returns absolute paths, in directory order.
 */
function sources(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/u.test(entry)) found.push(path)
    }
  }
  walk(resolve(SOURCE))
  return found
}

/**
 * The tokens one source references, with what follows each name in the `var()`.
 * @param text - the file's contents.
 * @returns the name and the remainder of the call for every reference.
 */
function references(text: string): { name: string; rest: string }[] {
  return [...text.matchAll(/var\((--[a-z0-9-]+)([^)]*)\)/gu)].map((match) => ({
    name: match[1] ?? '',
    rest: (match[2] ?? '').trim(),
  }))
}

test('every token the client styles with is one the theme defines', () => {
  for (const path of sources()) {
    for (const reference of references(readFileSync(path, 'utf8'))) {
      assert.ok(
        ALLOWED.includes(reference.name as (typeof ALLOWED)[number]),
        `${relative(resolve('.'), path)}: ${reference.name} is not a theme token`,
      )
    }
  }
})

test('no reference carries a fallback, so a missing token cannot pass as a colour', () => {
  for (const path of sources()) {
    for (const reference of references(readFileSync(path, 'utf8'))) {
      assert.equal(
        reference.rest,
        '',
        `${relative(resolve('.'), path)}: ${reference.name} falls back to ${reference.rest}`,
      )
    }
  }
})

test('every listed token is still in use', () => {
  const used = new Set(sources().flatMap((path) => references(readFileSync(path, 'utf8')).map((r) => r.name)))
  for (const name of ALLOWED) {
    assert.ok(used.has(name), `${name} is listed but no longer used`)
  }
})
