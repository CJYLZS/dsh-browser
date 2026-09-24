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
import { BrowserGlyph } from './glyph.ts'
/**
 * Placement for the glyph inside a chip.
 *
 * The chip lays its content out as text, so the icon is an inline box nudged
 * onto the text's optical centre — this bundle has no stylesheet of its own, so
 * it cannot be a class.
 */
const GLYPH: Readonly<Record<string, string>> = {
  display: 'inline-block', verticalAlign: '-3px', marginRight: '5px', flex: '0 0 auto',
}

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the globe followed by the tab's title text.
 */
export function BrowserTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <span style={GLYPH}><BrowserGlyph size={14} /></span>
      {tab.title}
    </>
  )
}
