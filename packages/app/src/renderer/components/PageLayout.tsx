import type { ReactNode } from 'react'
import AppTopBar from './AppTopBar.js'
import SidebarRail, { FOLD_EASE } from './SidebarRail.js'
import SidebarResizeHandle from './SidebarResizeHandle.js'

const RIGHT_PANEL_WIDTH = 280

type Props = {
  sidebar: ReactNode
  sidebarCollapsed: boolean
  sidebarWidth: number
  sidebarResizing: boolean
  onSidebarWidthChange: (width: number) => void
  onSidebarResizeStart: () => void
  onSidebarResizeEnd: (width: number) => void
  onToggleSidebar: () => void
  trafficLightInset?: boolean
  topBar?: ReactNode
  rightPanel?: ReactNode
  rightPanelOpen?: boolean
  children: ReactNode
}

/**
 * Three-column layout shell. AppTopBar sits at the top and spans the
 * full window width (sidebar + content + rightPanel are all sibling
 * columns BELOW it). The bar paints a matching surface-coloured
 * segment over the right column so the top edge reads as one band.
 *
 * Slot prop pattern — callers pass JSX nodes for each slot instead of
 * portaling content via DOM ids. Keeps the layout's contract typed
 * and the render tree matching the DOM tree.
 */
export default function PageLayout({
  sidebar,
  sidebarCollapsed,
  sidebarWidth,
  sidebarResizing,
  onSidebarWidthChange,
  onSidebarResizeStart,
  onSidebarResizeEnd,
  onToggleSidebar,
  trafficLightInset = true,
  topBar,
  rightPanel,
  rightPanelOpen = false,
  children,
}: Props) {
  return (
    <div className="relative flex flex-col h-screen bg-warm-bg dark:bg-dark-bg text-warm-text dark:text-dark-text">
      <AppTopBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        trafficLightInset={trafficLightInset}
        sidebarWidth={sidebarWidth}
        sidebarResizing={sidebarResizing}
      >
        {topBar}
      </AppTopBar>
      <div className="flex flex-1 min-h-0">
        <SidebarRail
          collapsed={sidebarCollapsed}
          collapsedWidth={!trafficLightInset ? 'chrome' : 'none'}
          width={sidebarWidth}
          resizing={sidebarResizing}
        >
          {sidebar}
        </SidebarRail>
        {!sidebarCollapsed && (
          <SidebarResizeHandle
            width={sidebarWidth}
            onWidthChange={onSidebarWidthChange}
            onResizeStart={onSidebarResizeStart}
            onResizeEnd={onSidebarResizeEnd}
          />
        )}
        <div className="relative flex flex-col flex-1 min-w-0">
          {children}
        </div>
        <div
          className="flex-none overflow-hidden"
          style={{
            width: rightPanelOpen ? RIGHT_PANEL_WIDTH : 0,
            transition: `width 327ms ${FOLD_EASE}`,
          }}
          aria-hidden={!rightPanelOpen}
        >
          <div style={{ width: RIGHT_PANEL_WIDTH, height: '100%' }}>
            {rightPanel}
          </div>
        </div>
      </div>
    </div>
  )
}
