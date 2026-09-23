/**
 * Build for both halves.
 *
 * The host half is a self-contained ESM Node library: `@deepseek-ai/*` imports
 * stay external (the profile resolves them), and so do `playwright-core` and
 * `ws` — both are real dependencies of this package, present next to the build
 * output in a `link:` install, and neither carries an install script.
 *
 * The client half is the loader artifact: a classic-script CJS factory
 * registered through `window.__ModuleLoader__.load`, with the platform module
 * table left external (see `PLATFORM_MODULES` in the harness
 * `packages/client/web/src/platform.ts` — that list is the module table, and
 * a specifier outside it must be inlined or imported type-only).
 */
import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-browser'

/** Module-table entries the client bundle may require (the shell's platform baseline). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Host-side specifiers the profile (or this package's own install) resolves at runtime. */
const HOST_EXTERNALS = /^(?:@deepseek-ai\/|playwright-core(?:\/|$)|ws(?:\/|$))/

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: (specifier: string) => HOST_EXTERNALS.test(specifier),
    },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    deps: {
      neverBundle: (specifier: string) => CLIENT_EXTERNALS.includes(specifier),
      alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.includes(specifier),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      // banner/footer/intro live in outputOptions: a dropped intro would leave
      // `exports`/`module` as free variables, and the loader factory then throws
      // "exports is not defined" when the client module system executes it.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
