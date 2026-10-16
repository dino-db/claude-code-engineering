import type { SkillAction } from '../types'

/*
 * The slash commands a repository's own skills give, read from its
 * .claude/skills/<folder>/SKILL.md files, for the pane's action buttons.
 * Pure: the hooks module reads the files.
 */

/** The frontmatter's `key: value` lines, quotes dropped; empty without frontmatter. */
function frontmatter(text: string): Record<string, string> {
  const lines = text.replace(/\r/g, '').split('\n')
  if (lines[0]?.trim() !== '---') return {}
  const fields: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (match?.[1]) fields[match[1]] = (match[2] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  return fields
}

/**
 * The command a skill gives: its frontmatter `name`, else its folder's, as
 * Claude Code names it. None for a skill marked `user-invocable: false`.
 */
export function parseSkill(folder: string, text: string): SkillAction | null {
  const fields = frontmatter(text)
  if (fields['user-invocable'] === 'false') return null
  const name = fields.name || folder
  if (!/^[\w.-]+$/.test(name)) return null
  return { name, takesArgument: Boolean(fields['argument-hint']) }
}

/** What a button puts in the prompt: a space after a command that takes an argument, for typing it. */
export function commandText(skill: SkillAction): string {
  return skill.takesArgument ? `/${skill.name} ` : `/${skill.name}`
}

export function sortSkills(skills: readonly SkillAction[]): SkillAction[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name))
}
