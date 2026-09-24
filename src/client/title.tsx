/**
 * The browser's chip title: the globe before the tab's own label.
 *
 * Registered under `sidebar.right.pane.tab.title`; without a registrant the chip
 * falls back to the registry's captured title text, which is how the browser
 * used to be the only tab in the strip with no glyph of its own.
 *
 * The label comes from the tab record rather than from this module's copy,
 * because the record is what the chip already shows: the two cannot disagree.
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CHIP_GLYPH, CHIP_GLYPH_SIZE } from './chip.ts'
import { BrowserGlyph } from './glyph.ts'

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the globe followed by the tab's title text.
 */
export function BrowserTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <span style={CHIP_GLYPH}><BrowserGlyph size={CHIP_GLYPH_SIZE} /></span>
      {tab.title}
    </>
  )
}
