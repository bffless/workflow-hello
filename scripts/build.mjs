#!/usr/bin/env node
// Build the workflow-hello bundle: single-file islands, the `script` step
// module copied verbatim, then `@bffless/workflow-lint`'s `workflow index`
// verb lints `.bffless/workflows/` and writes the bundle's index.json + a
// landing page.
//
// Modeled on the monorepo's apps/workflow/scripts/stage-hello.mjs (the island
// build + script copy); the index.json/landing-page half that script wrote by
// hand is replaced here by `workflow index` (M3 Phase 1) — this repo is that
// tool's first customer outside the monorepo (06).
import { mkdirSync, copyFileSync, readdirSync, rmSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * This repo's own binaries, never `npx` (R23): a reproducible build never
 * silently reaches the network for a tool this repo already pins in
 * `package.json`.
 */
const bin = (name) => join(repoDir, 'node_modules', '.bin', name)

/**
 * `@bffless/workflow-lint@1.0.0`'s `dist/cli.js` only runs its CLI when
 * `import.meta.url === pathToFileURL(process.argv[1]).href`. Under pnpm's
 * node_modules layout `node_modules/@bffless/workflow-lint` is a symlink into
 * `.pnpm/…`; running it via `node_modules/.bin/workflow` (the shim `bin()`
 * above would resolve) leaves `argv[1]` at the symlinked path while
 * `import.meta.url` resolves to the realpath, so the check never matches —
 * the process exits 0 having done *nothing*, no output at all. Filed
 * upstream; worked around here by resolving the package's realpath first and
 * invoking `node <realpath>/dist/cli.js` directly, which is what the shim
 * would have done had the check not silently failed. No network involved —
 * still the repo's own pinned devDependency, matching R23's intent.
 */
const workflowCli = join(realpathSync(join(repoDir, 'node_modules', '@bffless', 'workflow-lint')), 'dist', 'cli.js')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const outIdx = args.indexOf('--out')
const explicitOut = outIdx > -1 ? args[outIdx + 1] : null

// `--check` is a "does it build" gate and nothing more: the whole build runs
// into a throwaway temp dir, which is discarded when it's done.
const out = checkOnly
  ? mkdtempSync(join(tmpdir(), 'workflow-hello-build-'))
  : (explicitOut ?? join(repoDir, 'dist'))

try {
  // ---------------------------------------------------------------------
  // Islands — one single-file Vite build each (see vite.islands.config.ts).
  // Read from the directory rather than hard-coded, so a third island needs
  // no change here.
  // ---------------------------------------------------------------------
  const islandsSrcDir = join(repoDir, 'islands')
  const ISLANDS = readdirSync(islandsSrcDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const islandDir = join(out, 'islands')
  rmSync(islandDir, { recursive: true, force: true })
  mkdirSync(islandDir, { recursive: true })

  // Type-checked here, by the thing that publishes the bundle: a broken
  // island or script fails the build, before anything is uploaded.
  execFileSync(bin('tsc'), ['-p', 'tsconfig.json'], { cwd: repoDir, stdio: 'inherit' })

  for (const island of ISLANDS) {
    execFileSync(bin('vite'), ['build', '-c', 'vite.islands.config.ts'], {
      cwd: repoDir,
      stdio: 'inherit',
      env: { ...process.env, WORKFLOW_ISLAND: island, WORKFLOW_ISLANDS_OUT: islandDir },
    })
  }

  // ---------------------------------------------------------------------
  // Scripts — copied verbatim; the Worker fetches them as modules. Excludes
  // this file itself: `scripts/` holds both the implementation's own script
  // step modules and this build tool, unlike the monorepo's separate
  // `hello/scripts/` vs `scripts/` split.
  // ---------------------------------------------------------------------
  const scriptsSrcDir = join(repoDir, 'scripts')
  const scriptOut = join(out, 'scripts')
  rmSync(scriptOut, { recursive: true, force: true })

  const scriptFiles = readdirSync(scriptsSrcDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'build.mjs' && /\.m?js$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  if (scriptFiles.length > 0) {
    mkdirSync(scriptOut, { recursive: true })
    for (const file of scriptFiles) copyFileSync(join(scriptsSrcDir, file), join(scriptOut, file))
  }

  // ---------------------------------------------------------------------
  // .bffless/workflows/index.json + a landing page — `workflow index` lints
  // every workflow in .bffless/workflows and, only if they all pass, writes
  // the bundle's index.json (which also lists the islands/scripts already
  // staged above) and copies the YAMLs verbatim.
  // ---------------------------------------------------------------------
  execFileSync(
    process.execPath,
    [
      workflowCli,
      'index',
      '.bffless/workflows',
      '--out',
      out,
      '--impl',
      'hello',
      '--name',
      'Hello',
      '--description',
      'M2 test implementation: hello (echo, slow job + poll, fail-on-purpose) and an interactive island round-trip; two islands (pick-line, line-viewer); analyze.',
      '--rules',
      '.bffless/proxy-rules/hello',
      '--path-prefix',
      '/api/hello',
    ],
    { cwd: repoDir, stdio: 'inherit' },
  )

  console.log('built', out)
} finally {
  if (checkOnly) rmSync(out, { recursive: true, force: true })
}
