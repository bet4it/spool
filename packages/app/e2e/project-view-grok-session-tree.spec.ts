import { test, expect } from '@playwright/test'
import { launchApp, waitForSync, type AppContext } from './helpers/launch'

let ctx: AppContext

test.beforeAll(async () => {
  ctx = await launchApp()
})

test.afterAll(async () => {
  await ctx?.cleanup()
})

// Mirrors the session ids in e2e/fixtures/grok-home/sessions.
const PARENT = '01a03000-0000-7000-8000-000000000001'
const CHILD_A = '01a03000-0000-7000-8000-000000000002'
const CHILD_B = '01a03000-0000-7000-8000-000000000003'
const SUBAGENT = '01a03000-0000-7000-8000-000000000004'

async function openTestProject(window: import('@playwright/test').Page) {
  // The grok fixture sessions live in /tmp/test-project — same project as
  // the claude and codex fixtures, so its sidebar row groups all of them.
  // aria-label starts with the display name, so "test-project," excludes
  // the sibling 'test-project-grok' project that also contains the substring.
  const row = window
    .locator('[data-testid="sidebar-project-row"]')
    .filter({ has: window.locator('span', { hasText: /^test-project$/ }) })
  await row.click()
  await expect(window.locator('[data-testid="project-view"]')).toBeVisible({ timeout: 5000 })
}

test('project view nests grok child sessions under their parent', async () => {
  const { window } = ctx
  await waitForSync(window)
  await openTestProject(window)

  // Parent row renders with a tree toggle and its child count (two fork
  // children plus the plain subagent, resolved via the parent's
  // subagents/<id>/meta.json — all three fold here).
  const parentRow = window.locator(`[data-testid="session-row"][data-session-uuid="${PARENT}"]`)
  await expect(parentRow).toBeVisible({ timeout: 5000 })
  await expect(parentRow.locator('[data-testid="session-tree-toggle"]')).toBeVisible()
  await expect(parentRow).toContainText(/3/)

  // Children start collapsed: hidden from the list.
  const childA = window.locator(`[data-testid="session-row"][data-session-uuid="${CHILD_A}"]`)
  const childB = window.locator(`[data-testid="session-row"][data-session-uuid="${CHILD_B}"]`)
  const subagent = window.locator(`[data-testid="session-row"][data-session-uuid="${SUBAGENT}"]`)
  await expect(childA).toHaveCount(0)
  await expect(childB).toHaveCount(0)
  await expect(subagent).toHaveCount(0)

  // Expand: all three children appear, indented beneath the parent.
  await parentRow.locator('[data-testid="session-tree-toggle"]').click()
  await expect(childA).toBeVisible()
  await expect(childB).toBeVisible()
  await expect(subagent).toBeVisible()
  await expect(childA).toHaveAttribute('data-tree-depth', '1')
  await expect(childB).toHaveAttribute('data-tree-depth', '1')
  await expect(subagent).toHaveAttribute('data-tree-depth', '1')

  // Collapse again hides them.
  await parentRow.locator('[data-testid="session-tree-toggle"]').click()
  await expect(childA).toHaveCount(0)
  await expect(subagent).toHaveCount(0)
})

test('project view grok subagent session opens its own detail page', async () => {
  const { window } = ctx
  await waitForSync(window)
  await openTestProject(window)

  const parentRow = window.locator(`[data-testid="session-row"][data-session-uuid="${PARENT}"]`)
  await expect(parentRow).toBeVisible({ timeout: 5000 })
  await parentRow.locator('[data-testid="session-tree-toggle"]').click()

  const subagent = window.locator(`[data-testid="session-row"][data-session-uuid="${SUBAGENT}"]`)
  await subagent.click()
  await expect(window.locator('[data-testid="session-detail"]')).toBeVisible({ timeout: 5000 })
})

test('library landing groups the grok family under the parent row', async () => {
  const { window } = ctx
  // Prior tests navigated into the project view; go back to the library
  // landing before asserting on its rows.
  await window.locator('[data-testid="sidebar-library"]').click()
  await expect(window.locator('[data-testid="library-landing"]')).toBeVisible({ timeout: 5000 })
  await waitForSync(window)

  // The family parent is the grok project's most recent root; it renders
  // with a toggle, and the standalone sibling project's session stays a
  // root row of its own (never nested under the family).
  const parentRow = window.locator(`[data-testid="session-row"][data-session-uuid="${PARENT}"]`)
  await expect(parentRow).toBeVisible({ timeout: 10000 })
  await expect(parentRow.locator('[data-testid="session-tree-toggle"]')).toBeVisible()

  const childA = window.locator(`[data-testid="session-row"][data-session-uuid="${CHILD_A}"]`)
  await expect(childA).toHaveCount(0)

  await parentRow.locator('[data-testid="session-tree-toggle"]').click()
  await expect(childA).toBeVisible()
  await expect(childA).toHaveAttribute('data-tree-depth', '1')

  const standalone = window.locator(`[data-testid="session-row"][data-session-uuid="01a03000-0000-7000-8000-000000000010"]`)
  await expect(standalone).toBeVisible()
  await expect(standalone).toHaveAttribute('data-tree-depth', '0')
})
