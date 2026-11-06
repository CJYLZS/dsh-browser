/**
 * The built client bundle's registration id is the package name.
 *
 * The harness keys every client boot row by the package's `name`
 * (`graphRow(packageName, …)` in `packages/client/modules`), and the loader
 * matches a script's `window.__ModuleLoader__.load({id})` against that key: a
 * bundle that registers any other id has executed without registering the row,
 * so the whole entry fails to import and the boot report says one entry did not
 * activate. The id was hand-copied as `dsh-browser` and did not follow the
 * package when it moved to the `@cjylzs` scope, which is the failure the
 * artifact is checked for here. See
 * `.agents/notes/implemented/bug-fix/2026-11-06-client-bundle-id-is-the-package-name.md`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('the client bundle registers the package name the boot row is keyed by', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { name: string }
  const bundle = readFileSync(resolve('lib/client.js'), 'utf8')
  const registrations: { id: string }[] = []
  runInNewContext(bundle, {
    window: {
      __ModuleLoader__: {
        load: (registration: { id: string }) => {
          registrations.push(registration)
        },
      },
    },
  })
  assert.equal(registrations.length, 1, 'one bundle registers exactly once')
  assert.equal(
    registrations[0]?.id,
    pkg.name,
    'the registration id must be the package name, or the harness row never resolves',
  )
})
