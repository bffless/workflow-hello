import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..')

const outDirs: string[] = []

function tmpOut(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-hello-build-test-'))
  outDirs.push(dir)
  return dir
}

afterEach(() => {
  while (outDirs.length > 0) {
    rmSync(outDirs.pop()!, { recursive: true, force: true })
  }
})

describe('scripts/build.mjs', () => {
  // Two Vite builds (one per island) plus a `tsc` pass — slow relative to a
  // typical unit test.
  it(
    'builds a self-contained bundle',
    () => {
      const outDir = tmpOut()

      execFileSync('node', ['scripts/build.mjs', '--out', outDir], { cwd: repoDir, stdio: 'inherit' })

      const index = JSON.parse(readFileSync(join(outDir, '.bffless/workflows/index.json'), 'utf8'))
      expect(index.impl).toBe('hello')
      expect(index.workflows).toHaveLength(2)
      // The payoff of `headless: auto` / `headless: { mode: skip, ... }`: a
      // workflow with no interactive step that would fail fast headless.
      expect(index.workflows.every((w: { headlessSafe: boolean }) => w.headlessSafe)).toBe(true)

      const islandFiles = ['pick-line.html', 'line-viewer.html']
      for (const file of islandFiles) {
        const html = readFileSync(join(outDir, 'islands', file), 'utf8')
        expect(html.length).toBeGreaterThan(0)
        // Self-contained: an island runs in an opaque-origin iframe srcdoc and
        // cannot fetch a sibling script.
        expect(html).not.toMatch(/<script[^>]*\ssrc=/i)
      }

      const builtScript = readFileSync(join(outDir, 'scripts', 'poster-card.js'))
      const sourceScript = readFileSync(join(repoDir, 'scripts', 'poster-card.js'))
      expect(builtScript.equals(sourceScript)).toBe(true)

      const landing = readFileSync(join(outDir, 'index.html'), 'utf8')
      expect(landing.length).toBeGreaterThan(0)
    },
    120_000,
  )

  // preview.yml builds the same source under a per-PR alias (`--impl
  // hello-pr-<N> --name 'Hello (PR #<N>)'`) — the published index.json must
  // say which implementation it is, since the harness reads it back. This is
  // exactly the failure mode the workflow-lint CLI bug (see build.mjs) would
  // have hidden: a green build whose bundle still claims `impl: hello`.
  it(
    'takes --impl/--name and publishes them, not the default',
    () => {
      const outDir = tmpOut()

      execFileSync(
        'node',
        ['scripts/build.mjs', '--out', outDir, '--impl', 'hello-pr-7', '--name', 'Hello (PR #7)'],
        { cwd: repoDir, stdio: 'inherit' },
      )

      const index = JSON.parse(readFileSync(join(outDir, '.bffless/workflows/index.json'), 'utf8'))
      expect(index.impl).toBe('hello-pr-7')
      expect(index.name).toBe('Hello (PR #7)')
    },
    120_000,
  )
})

describe('interactive.workflow.yaml headless declarations', () => {
  const source = readFileSync(join(repoDir, '.bffless/workflows/interactive.workflow.yaml'), 'utf8')

  it('declares headless: auto on the pick/choose island step', () => {
    const pickJob = source.slice(source.indexOf('\n  pick:'), source.indexOf('\n  card:'))
    expect(pickJob).toMatch(/headless:\s*auto/)
  })

  it('declares headless mode: skip on both forms', () => {
    const skipCount = (source.match(/headless:\s*\{\s*mode:\s*skip/g) ?? []).length
    expect(skipCount).toBe(1) // only review/confirm's form is in this file
  })
})

describe('hello.workflow.yaml headless declarations', () => {
  const source = readFileSync(join(repoDir, '.bffless/workflows/hello.workflow.yaml'), 'utf8')

  it('declares headless mode: skip on confirm/review', () => {
    expect(source).toMatch(/headless:\s*\{\s*mode:\s*skip/)
  })
})
