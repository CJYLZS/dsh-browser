/**
 * Read the skill file the plugin ships into the catalog.
 *
 * The frontmatter block is stripped rather than passed on: the model reads the
 * body as instructions, and a YAML header in the middle of instructions is
 * noise. Keeping the identity in the file rather than in this module is what
 * lets the guidance be edited without touching code — which is also why a
 * missing or nameless file is an error here and a warning at load: the browser
 * works without its guidance, and the file is still the one home of it.
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/**
 * Where the guidance ships, resolved from whichever of `src/` or `lib/` is
 * running: both sit one level under the package root, so the built plugin and
 * the source tests read the same file.
 */
const SKILL_FILE = fileURLToPath(new URL('../skills/dsh-browser/SKILL.md', import.meta.url))

/** What a skill file's frontmatter says, and the body it introduces. */
export interface SkillFile {
  /** Kebab-case identifier the catalog lists the skill under. */
  readonly name: string
  /** One line saying when the skill applies, shown before it is loaded. */
  readonly description: string
  /** Extra routing guidance, when the file gives any. */
  readonly whenToUse?: string
  /** The instructions themselves, with the frontmatter removed. */
  readonly content: string
}

/**
 * Read a skill file.
 * @param source - the file's text, frontmatter block first.
 * @returns the fields the frontmatter declares and the body after it.
 * @throws {Error} when the file has no frontmatter, or does not name and
 * describe itself.
 */
export function parseSkillFile(source: string): SkillFile {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(source)
  if (front === null) {
    throw new Error('dsh-browser: the skill file does not open with a "---" frontmatter block')
  }
  const fields = new Map<string, string>()
  for (const line of (front[1] ?? '').split(/\r?\n/u)) {
    const entry = /^([a-zA-Z][a-zA-Z-]*):\s*(.*)$/u.exec(line)
    if (entry === null) continue
    // A description is prose and often contains a colon, so only the outermost
    // quotes are removed rather than parsing the value as YAML.
    fields.set((entry[1] ?? '').toLowerCase(), (entry[2] ?? '').trim().replace(/^"|"$|^'|'$/gu, ''))
  }
  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (name === '' || description === '') {
    throw new Error('dsh-browser: the skill file must carry a name and a description')
  }
  const whenToUse = fields.get('whentouse')
  return {
    name,
    description,
    ...whenToUse === undefined || whenToUse === '' ? {} : { whenToUse },
    content: source.slice(front[0].length),
  }
}

/**
 * The guidance this plugin contributes to the skill catalog.
 *
 * Contribution is a registration rather than a directory the harness scans, so
 * the file is read once at load and belongs to this plugin only.
 * @returns the registration to hand to the skill registry.
 * @throws {Error} when the shipped file cannot be read or does not describe itself.
 */
export function browserSkill(): SkillRegistration {
  const source = readFileSync(SKILL_FILE, 'utf8')
  const { name, description, whenToUse, content } = parseSkillFile(source)
  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    source: 'custom',
    path: SKILL_FILE,
    resourceBase: { kind: 'directory', path: dirname(SKILL_FILE) },
    content,
  }
}
