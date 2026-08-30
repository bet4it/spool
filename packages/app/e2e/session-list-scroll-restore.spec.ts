import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, waitForSync, type AppContext } from './helpers/launch'

// Regression test for: opening a session from the list and pressing
// Back used to remount the list surface, resetting its scroll to the
// top and discarding the pages the user had already loaded. The
// pre-session surface now stays mounted (hidden) while a session is
// open, so Back must restore the scroll offset.
//
// Both assertions hang off scrollTop at the bottom of the list: if the
// list remounted, either the offset resets to 0 or the loaded pages
// vanish and the browser clamps scrollTop to the single-page height —
// either way it no longer equals the pre-click bottom.

let ctx: AppContext

const EXTRA_SESSIONS = 120

test.beforeAll(async () => {
  ctx = await launchApp({
    extraFixtures: ({ claudeDir }) => {
      // One extra Claude project with EXTRA_SESSIONS sessions. The
      // default fixture projects have too few sessions to scroll, so
      // we synthesize a long list in a project of its own.
      const fixtureDir = join(claudeDir, 'scroll-fixture-project')
      mkdirSync(fixtureDir, { recursive: true })
      for (let i = 1; i <= EXTRA_SESSIONS; i += 1) {
        const num = i.toString().padStart(3, '0')
        const minute = (i % 60).toString().padStart(2, '0')
        writeFileSync(
          join(fixtureDir, `scroll-session-${num}.jsonl`),
          [
            JSON.stringify({
              type: 'user',
              sessionId: `scroll-fixture-session-${num}`,
              cwd: '/tmp/scroll-fixture-project',
              uuid: `scroll-msg-${num}-1`,
              timestamp: `2026-05-20T10:${minute}:00Z`,
              message: { role: 'user', content: `Scroll fixture session ${num}` },
            }),
            JSON.stringify({
              type: 'assistant',
              uuid: `scroll-msg-${num}-2`,
              timestamp: `2026-05-20T10:${minute}:05Z`,
              message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'Reply.' }] },
            }),
          ].join('\n') + '\n',
        )
      }
    },
  })
})

test.afterAll(async () => {
  await ctx?.cleanup()
})

test('Back from a project-view session restores the list scroll position', async () => {
  const { window } = ctx
  await waitForSync(window)

  await window
    .locator('[data-testid="sidebar-project-row"][data-identity-key]')
    .filter({ hasText: 'scroll-fixture-project' })
    .first()
    .click()
  await expect(window.locator('[data-testid="project-view"]')).toBeVisible({ timeout: 10000 })

  const scroller = window.locator('[data-testid="project-view-scroll"]')
  // Paginate through the whole list: set scrollTop to its current max
  // repeatedly — each batch of endReached fetches appends content and
  // raises the max — until the end-of-list footer renders (cursor
  // exhausted). Poll generously: 120 sessions = 3 pages.
  for (let i = 0; i < 30; i += 1) {
    const atEnd = await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight
      return el.scrollHeight - el.clientHeight - el.scrollTop < 2
    })
    if (!atEnd) {
      await window.waitForTimeout(100)
      continue
    }
    const done = window.locator('[data-testid="project-view"] [data-testid="session-list-done"]')
    if (await done.isVisible().catch(() => false)) break
    // The last fetch may still be in flight — wait for either the
    // footer or a content height change before re-checking.
    await window.waitForTimeout(200)
    if (await done.isVisible().catch(() => false)) break
  }
  await expect(
    window.locator('[data-testid="project-view"] [data-testid="session-list-done"]'),
  ).toBeVisible({ timeout: 10000 })

  const scrollTopBefore = await scroller.evaluate((el) => el.scrollTop)
  expect(scrollTopBefore).toBeGreaterThan(1000)

  const rowUuid = await scroller.evaluate((el) => {
    const rows = el.querySelectorAll<HTMLElement>('[data-testid="session-row"]')
    return rows.length > 0 ? rows[Math.floor(rows.length / 2)]!.dataset['sessionUuid'] ?? null : null
  })
  expect(rowUuid).toBeTruthy()

  await window
    .locator(`[data-testid="session-row"][data-session-uuid="${rowUuid}"]`)
    .click()
  await expect(window.locator('[data-testid="session-detail"]')).toBeVisible({ timeout: 10000 })
  await window.locator('[data-testid="session-detail"] [aria-label="Back"]').click()
  await expect(window.locator('[data-testid="project-view"]')).toBeVisible({ timeout: 10000 })

  // The scroll offset (and, implicitly, the loaded pages it stands on)
  // must survive the round-trip.
  const scrollTopAfter = await scroller.evaluate((el) => el.scrollTop)
  expect(Math.abs(scrollTopAfter - scrollTopBefore)).toBeLessThanOrEqual(4)
  // And the list must still be at its paginated end — no reset to the
  // first page's shorter content.
  await expect(
    window.locator('[data-testid="project-view"] [data-testid="session-list-done"]'),
  ).toBeVisible({ timeout: 5000 })
})

test('Back from a library session restores the library scroll position', async () => {
  const { window } = ctx
  await waitForSync(window)

  await window.locator('[data-testid="sidebar-library"]').click()
  await expect(window.locator('[data-testid="library-landing"]')).toBeVisible({ timeout: 10000 })

  const scroller = window.locator('[data-testid="library-landing-scroll"]')
  for (let i = 0; i < 30; i += 1) {
    const atEnd = await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight
      return el.scrollHeight - el.clientHeight - el.scrollTop < 2
    })
    if (!atEnd) {
      await window.waitForTimeout(100)
      continue
    }
    const done = window.locator('[data-testid="library-landing"] [data-testid="session-list-done"]')
    if (await done.isVisible().catch(() => false)) break
    await window.waitForTimeout(200)
    if (await done.isVisible().catch(() => false)) break
  }
  await expect(
    window.locator('[data-testid="library-landing"] [data-testid="session-list-done"]'),
  ).toBeVisible({ timeout: 10000 })

  const scrollTopBefore = await scroller.evaluate((el) => el.scrollTop)
  expect(scrollTopBefore).toBeGreaterThan(1000)

  const rowUuid = await scroller.evaluate((el) => {
    const rows = el.querySelectorAll<HTMLElement>('[data-testid="session-row"]')
    return rows.length > 0 ? rows[Math.floor(rows.length / 2)]!.dataset['sessionUuid'] ?? null : null
  })
  expect(rowUuid).toBeTruthy()

  await window
    .locator(`[data-testid="session-row"][data-session-uuid="${rowUuid}"]`)
    .click()
  await expect(window.locator('[data-testid="session-detail"]')).toBeVisible({ timeout: 10000 })
  await window.locator('[data-testid="session-detail"] [aria-label="Back"]').click()
  await expect(window.locator('[data-testid="library-landing"]')).toBeVisible({ timeout: 10000 })

  const scrollTopAfter = await scroller.evaluate((el) => el.scrollTop)
  expect(Math.abs(scrollTopAfter - scrollTopBefore)).toBeLessThanOrEqual(4)
  await expect(
    window.locator('[data-testid="library-landing"] [data-testid="session-list-done"]'),
  ).toBeVisible({ timeout: 5000 })
})
