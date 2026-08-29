import { test, expect } from '@playwright/test'
import { launchApp, waitForSync, type AppContext } from './helpers/launch'

let ctx: AppContext

test.beforeAll(async () => {
  ctx = await launchApp()
})

test.afterAll(async () => {
  await ctx?.cleanup()
})

const PARENT = 'aaaaaaaa-0000-4000-8000-000000000001'
const CHILD_A = 'aaaaaaaa-0000-4000-8000-000000000002'
const CHILD_B = 'aaaaaaaa-0000-4000-8000-000000000003'

async function openTestProject(window: import('@playwright/test').Page) {
  // The codex fixture sessions live in /tmp/test-project — same project as
  // the claude fixtures, so its sidebar row groups all of them together.
  const row = window
    .locator('[data-testid="sidebar-project-row"]')
    .filter({ hasText: 'test-project' })
    .first()
  await row.click()
  await expect(window.locator('[data-testid="project-view"]')).toBeVisible({ timeout: 5000 })
}

test('project view nests codex child sessions under their parent', async () => {
  const { window } = ctx
  await waitForSync(window)
  await openTestProject(window)

  // Parent row renders with a tree toggle and its child count.
  const parentRow = window.locator(`[data-testid="session-row"][data-session-uuid="${PARENT}"]`)
  await expect(parentRow).toBeVisible({ timeout: 5000 })
  await expect(parentRow.locator('[data-testid="session-tree-toggle"]')).toBeVisible()

  // Children start collapsed: hidden from the list.
  const childA = window.locator(`[data-testid="session-row"][data-session-uuid="${CHILD_A}"]`)
  const childB = window.locator(`[data-testid="session-row"][data-session-uuid="${CHILD_B}"]`)
  await expect(childA).toHaveCount(0)
  await expect(childB).toHaveCount(0)

  // Expand: both children appear, indented beneath the parent.
  await parentRow.locator('[data-testid="session-tree-toggle"]').click()
  await expect(childA).toBeVisible()
  await expect(childB).toBeVisible()
  await expect(childA).toHaveAttribute('data-tree-depth', '1')
  await expect(childB).toHaveAttribute('data-tree-depth', '1')

  // Collapse again hides them.
  await parentRow.locator('[data-testid="session-tree-toggle"]').click()
  await expect(childA).toHaveCount(0)
})

test('project view child session opens its own detail page', async () => {
  const { window } = ctx
  await waitForSync(window)
  await openTestProject(window)

  const parentRow = window.locator(`[data-testid="session-row"][data-session-uuid="${PARENT}"]`)
  await expect(parentRow).toBeVisible({ timeout: 5000 })
  await parentRow.locator('[data-testid="session-tree-toggle"]').click()

  const childB = window.locator(`[data-testid="session-row"][data-session-uuid="${CHILD_B}"]`)
  await childB.click()
  await expect(window.locator('[data-testid="session-detail"]')).toBeVisible({ timeout: 5000 })
})
