/**
 * The browser's chip title: the globe before the tab's own label.
 *
 * Registered under `sidebar.right.pane.tab.title`; without a registrant the chip
 * falls back to the registry's captured title text, which is how the browser
 * used to be the only tab in the strip with no glyph of its own.
 *
 * The label is the page's own, live: a tab names a page, and what makes the
 * tabs tell each other apart is the page renaming itself, not the moment the
 * tab was opened. The facts come from the loop that follows the host's report
 * (`pages.ts`); until they name this tab's page the captured text stands in.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CHIP_GLYPH, CHIP_GLYPH_SIZE } from './chip.ts'
import { BrowserGlyph } from './glyph.ts'
import { pageFactsOf, subscribePageFacts } from './pages.ts'

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the globe followed by the tab's title text.
 */
export function BrowserTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  const facts = useSyncExternalStore(subscribePageFacts, () => pageFactsOf(tab.contentId))
  const label = facts !== undefined && facts.title !== '' ? facts.title : tab.title
  return (
    <>
      <span style={CHIP_GLYPH}><BrowserGlyph size={CHIP_GLYPH_SIZE} /></span>
      {label}
    </>
  )
}
