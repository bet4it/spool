// Deploy-shape guard for the companion Worker (workers/spool-share-deletion).
//
// The sweep logic is unit-tested in deletion-worker.test.ts; what has no
// other coverage is the deploy shell itself — the re-export path from the
// Worker package to this backend file, and the wrangler.toml binding set.
// Both fail silently in production if they drift (a moved file bundles to
// an empty Worker; a missing binding turns the sweep into per-run errors),
// so they get pinned here, in a suite CI already runs.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DELETION_BINDING_NAMES } from '../functions/_scheduled/deletion-worker'

// Resolve relative to the package root (vitest runs with cwd = package dir)
// rather than `new URL(import.meta.url)`: under TS 7 + @cloudflare/workers-types,
// the lib.dom `URL` from `new URL` is not assignable to the `URL` that
// @types/node's `fileURLToPath` expects (URLSearchParamsIterator lacks
// [Symbol.dispose]), so the cross-lib URL construction trips TS2769.
const PKG_DIR = resolve(fileURLToPath(import.meta.url as string), '..')
const WORKER_DIR = resolve(PKG_DIR, '..', '..', '..', 'workers', 'spool-share-deletion')

describe('spool-share-deletion deploy shape', () => {
  it('the Worker entry re-exports a scheduled handler', async () => {
    const shell = (await import('../../../workers/spool-share-deletion/src/worker')) as {
      default?: { scheduled?: unknown }
    }
    expect(typeof shell.default?.scheduled).toBe('function')
  })

  it('wrangler.toml declares exactly the bindings DeletionEnv needs', () => {
    const toml = readFileSync(resolve(WORKER_DIR, 'wrangler.toml'), 'utf8')
    const bindings = [...toml.matchAll(/^binding = "(\w+)"$/gm)].map((m) => m[1])
    expect(new Set(bindings)).toEqual(new Set(DELETION_BINDING_NAMES))
  })

  it('wrangler.toml keeps the cron and the entry path', () => {
    const toml = readFileSync(resolve(WORKER_DIR, 'wrangler.toml'), 'utf8')
    expect(toml).toMatch(/^crons = \["0 \*\/6 \* \* \*"\]$/m)
    expect(toml).toMatch(/^main = "src\/worker\.ts"$/m)
    // Resource names are shared with the backend's Pages bindings — a
    // rename here would silently point the sweep at empty resources.
    expect(toml).toContain('database_name = "spool-share-db"')
    expect(toml).toContain('bucket_name = "spool-snapshots"')
    expect(toml).toContain('bucket_name = "spool-og"')
    expect(toml).toContain('bucket_name = "spool-avatars"')
  })
})
