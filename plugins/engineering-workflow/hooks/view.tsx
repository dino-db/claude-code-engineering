import type { BoxProps, ButtonProps, CodeProps, ElementConstructor, InputProps, TextProps } from 'claude-code'

import type { DiffView, GitInfo, LinkState, PanelMenu, Repo, RepoGit, RepoRoots, SessionEntry, SkillAction, TerminalInfo, Tracker, WorkState } from '../types'
import { PHASES, PHASE_LABEL } from './classify'
import { labelOf } from './repo'
import { commandText } from './skills'
import { closePlan, entryLabel, nameProblem, sessionLook, shortId } from './switcher'
import type { SessionLook } from './switcher'
import { agentRows, workLine } from './work'
import type { AgentRow } from './work'
import { activeAgent, activeRepos, phaseStates, repoLabel, verification } from './tracker'
import type { PhaseState, Tone } from './tracker'

export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
}

export type PaneKit = Kit & {
  Button: ElementConstructor<ButtonProps>
  Code: ElementConstructor<CodeProps>
  /** Absent on mobile, which draws no field. */
  Input?: ElementConstructor<InputProps>
}

export const TITLE = 'Engineering Workflow'

/** What the sessions menu says, in it, when it cannot run Windows Terminal. */
export const NO_WT = 'Windows Terminal not found: open/new show the command to run'

/** One rule across the panel: green done, yellow in progress, red failed, grey otherwise. */
const STATE_LOOK: Record<PhaseState, { mark: string; label: string; color?: string }> = {
  done: { mark: '✓', label: 'done', color: 'green' },
  current: { mark: '▶', label: 'in progress', color: 'yellow' },
  failed: { mark: '✗', label: 'failed', color: 'red' },
  skipped: { mark: '–', label: 'skipped' },
  pending: { mark: '·', label: 'not started' },
  notNeeded: { mark: '–', label: 'not needed' },
}

const TONE_COLOR: Record<Tone, string | undefined> = {
  muted: undefined,
  pending: 'yellow',
  ok: 'green',
  warn: 'yellow',
  bad: 'red',
}

export type View = {
  tracker: Tracker
  git: GitInfo
  cwdRepo: Repo | null
  /** Each known repository's root, the session's own first. */
  roots: RepoRoots
  /** How the pane names each repository. */
  labels: Readonly<Record<Repo, string>>
  work: WorkState
  now: number
}

function branchText(git: RepoGit | null | undefined): string {
  if (!git) return '…'
  if (!git.branch) return git.error ?? 'no branch'
  return git.dirty ? `${git.branch} (${git.dirty} changed)` : git.branch
}

const LABEL_WIDTH = Math.max(...PHASES.map(phase => PHASE_LABEL[phase].length))

/** The phases on one line, for the rows above the prompt. */
function PhaseRow({ Box, Text }: Kit, tracker: Tracker, isIdle: boolean) {
  const states = phaseStates(tracker, isIdle)
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {PHASES.map((phase, index) => {
        const look = STATE_LOOK[states[phase]]
        return (
          <Text bold={states[phase] === 'current'} color={look.color} dimColor={!look.color}>
            {`${look.mark} ${PHASE_LABEL[phase]}${index < PHASES.length - 1 ? '  ›  ' : ''}`}
          </Text>
        )
      })}
    </Box>
  )
}

/** The phases one per line, with what each state means in words. */
function PhaseColumn({ Box, Text }: Kit, tracker: Tracker, isIdle: boolean) {
  const states = phaseStates(tracker, isIdle)
  return (
    <Box flexDirection="column">
      {PHASES.map(phase => {
        const look = STATE_LOOK[states[phase]]
        return (
          <Text color={look.color} dimColor={!look.color}>
            <Text bold={states[phase] === 'current'}>{`${look.mark} ${PHASE_LABEL[phase].padEnd(LABEL_WIDTH)}`}</Text>
            {`   ${look.label}`}
          </Text>
        )
      })}
    </Box>
  )
}

/**
 * One row per agent, its status beside it: Main working (yellow, the time
 * ticking), finished (green) or stopped, then each subagent still running.
 */
function AgentList({ Box, Text }: Kit, rows: readonly AgentRow[]) {
  const width = Math.max(...rows.map(row => row.name.length))
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <Text wrap="truncate-end">
          <Text dimColor>{index === 0 ? 'Agents     ' : ' '.repeat(11)}</Text>
          <Text bold>{row.name.padEnd(width)}</Text>
          <Text>{'  '}</Text>
          <Text color={row.line.color} dimColor={!row.line.color} bold={row.line.mark === '●'}>
            {`${row.line.mark} ${row.line.text}`}
          </Text>
          {row.detail ? <Text dimColor>{`  ${row.detail}`}</Text> : null}
        </Text>
      ))}
    </Box>
  )
}

/** The repositories with files modified in the session, the session's own first. */
function fileRepos(tracker: Tracker, cwdRepo: Repo | null, roots: RepoRoots): Repo[] {
  const order = [...(cwdRepo ? [cwdRepo] : []), ...Object.keys(roots), ...Object.keys(tracker.files)]
  return order.filter((repo, index) => order.indexOf(repo) === index && (repo === cwdRepo || (tracker.files[repo]?.length ?? 0) > 0))
}

/** The two rows above the prompt; the branch shown is the session's own repository's. */
export function band(kit: Kit, { tracker, git, cwdRepo, roots, labels, work, now }: View) {
  const { Box, Text } = kit
  const repos = activeRepos(tracker, cwdRepo)
  const status = verification(tracker)
  const working = workLine(work, now)
  const changed = fileRepos(tracker, cwdRepo, roots)
    .filter(repo => (tracker.files[repo]?.length ?? 0) > 0)
    .map(repo => `${labelOf(labels, repo)} ${tracker.files[repo]?.length ?? 0}`)
    .join(' · ')

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>{TITLE}</Text>
        {cwdRepo && (
          <Text>
            <Text dimColor>{`  ⎇ ${labelOf(labels, cwdRepo)} `}</Text>
            <Text>{branchText(git[cwdRepo])}</Text>
          </Text>
        )}
        <Text dimColor>{'  repo '}</Text>
        <Text>{repoLabel(repos, labels)}</Text>
        <Text dimColor>{'  agent '}</Text>
        <Text bold>{activeAgent(tracker)}</Text>
        {working && <Text color={working.color} dimColor={!working.color}>{`  ${working.mark} ${working.text}`}</Text>}
      </Text>
      <Box flexDirection="row" flexWrap="wrap">
        {PhaseRow(kit, tracker, !work.isWorking)}
        <Text dimColor>{'   verify '}</Text>
        <Text color={TONE_COLOR[status.tone]} dimColor={status.tone === 'muted'}>
          {status.label}
        </Text>
        <Text dimColor>{changed ? `   files ${changed}` : ''}</Text>
      </Box>
    </Box>
  )
}

function Heading({ Text }: Kit, title: string) {
  return (
    <Text bold underline>
      {title}
    </Text>
  )
}

const FILE_LIMIT = 15

export type MenuControl = {
  menu: PanelMenu
  /** The open sessions of every repository. */
  sessions: readonly SessionEntry[]
  selfId: string
  /** The session's repository, whose skills the menu offers; null outside any. */
  repo: Repo | null
  /** The repositories the sessions menu lists, by id with their roots. */
  repos: RepoRoots
  labels: Readonly<Record<Repo, string>>
  terminal: TerminalInfo
  skills: readonly SkillAction[]
  /** Why there are no skills, when there are none in a repository session. */
  skillsNote: string | null
  onToggle: () => void
  onLevel: (menu: PanelMenu) => void
  onOpen: (entry: SessionEntry) => void
  onName: (repo: Repo, name: string) => void
  onCreate: (repo: Repo, name: string) => void
  /** Closes the session, once confirmed. */
  onClose: (entry: SessionEntry) => void
  /** Puts the skill's command in the prompt and closes the menu. */
  onSkill: (command: string) => void
}

const LOOK: Record<SessionLook, string> = {
  self: '· this session',
  window: '● window',
  background: '◌ background',
  hand: 'opened by hand',
}

/**
 * A session's row in its repository's list: open it when it can be brought
 * up (or, without Windows Terminal, get the command that does), ✕ to close it
 * when it can be closed.
 */
function sessionRow(kit: PaneKit, c: MenuControl, entry: SessionEntry) {
  const { Box, Text, Button } = kit
  const look = sessionLook(entry, c.selfId)
  const line = `${entryLabel(entry)}  ${LOOK[look]}`
  const id = shortId(entry.sessionId)
  const close = closePlan(entry, c.selfId).kind
  const canClose = close === 'stop' || close === 'kill'
  const canOpen = c.terminal.hasWt ? look === 'window' || look === 'background' : look === 'background'
  const shown = c.terminal.hasWt ? line : look === 'background' ? `${line}  · copy command` : look === 'window' ? `${line}  · in another window` : line
  return (
    <Box flexDirection="row" columnGap={1}>
      {canOpen ? <Button key={`open-${id}`} plain label={shown} onPress={() => c.onOpen(entry)} /> : <Text dimColor>{shown}</Text>}
      {canClose && <Button key={`close-${id}`} plain dimColor label="✕" onPress={() => c.onLevel({ level: 'confirm', entry })} />}
    </Box>
  )
}

/** The fixed line the sessions menu shows while it cannot run Windows Terminal. */
function noTerminal({ Text }: PaneKit, c: MenuControl) {
  return c.terminal.hasWt ? [] : [<Text color="yellow">{NO_WT}</Text>]
}

/**
 * One level of the menu: sessions and skills; under sessions the repositories,
 * a repository's sessions, a session to close, a new session's repository, its
 * name, and the command to run by hand.
 */
function menuBody(kit: PaneKit, c: MenuControl) {
  const { Text, Button, Input } = kit
  const menu = c.menu
  const back = (to: PanelMenu) => <Button key="menu-back" plain dimColor label="← back" onPress={() => c.onLevel(to)} />
  const of = (repo: Repo) => c.sessions.filter(e => e.repo === repo)
  const label = (repo: Repo) => labelOf(c.labels, repo)
  const repos = Object.keys(c.repos)

  if (menu.level === 'main') {
    return [
      <Button key="menu-sessions" plain label="sessions ▸" onPress={() => c.onLevel({ level: 'sessions' })} />,
      <Button key="menu-skills" plain label="skills ▸" onPress={() => c.onLevel({ level: 'skills' })} />,
    ]
  }
  if (menu.level === 'skills') {
    const note = !c.repo
      ? 'skills show in a session inside a Git repository'
      : c.skills.length === 0
        ? (c.skillsNote ?? 'reading the skills…')
        : null
    return [
      <Text dimColor>{c.repo ? `${label(c.repo)} skills` : 'skills'}</Text>,
      ...(note
        ? [<Text dimColor>{note}</Text>]
        : [
            ...c.skills.map(skill => <Button key={`skill-${skill.name}`} plain label={`/${skill.name}`} onPress={() => c.onSkill(commandText(skill))} />),
            <Text dimColor>fills the prompt · Enter runs it</Text>,
          ]),
      back({ level: 'main' }),
    ]
  }
  if (menu.level === 'sessions') {
    return [
      ...noTerminal(kit, c),
      ...(repos.length === 0 ? [<Text dimColor>no repository known yet</Text>] : []),
      ...repos.map(repo => (
        <Button key={`sessions-${label(repo)}`} plain label={`${label(repo)} (${of(repo).length})`} onPress={() => c.onLevel({ level: 'list', repo })} />
      )),
      ...(repos.length > 0 ? [<Button key="sessions-new" plain label="+ new session" onPress={() => c.onLevel({ level: 'new' })} />] : []),
      back({ level: 'main' }),
    ]
  }
  if (menu.level === 'list') {
    const repo = menu.repo
    const rows = of(repo)
    return [
      ...noTerminal(kit, c),
      <Text dimColor>{`${label(repo)} sessions`}</Text>,
      ...(rows.length === 0
        ? [
            <Text dimColor>no open session</Text>,
            <Button key={`sessions-new-${label(repo)}`} plain label={`+ new ${label(repo)} session`} onPress={() => c.onLevel({ level: 'name', repo, name: '' })} />,
          ]
        : rows.map(entry => sessionRow(kit, c, entry))),
      back({ level: 'sessions' }),
    ]
  }
  if (menu.level === 'confirm') {
    const { entry } = menu
    const repo = entry.repo
    return [
      <Text color="yellow">{`close ${repo ? `${label(repo)} · ` : ''}${entryLabel(entry)}?`}</Text>,
      <Text dimColor>{entry.background ? 'stops it in the background' : 'ends its claude; the tab stays'} · /resume brings it back</Text>,
      <Button key="close-confirm" plain label="close it" onPress={() => c.onClose(entry)} />,
      back(repo ? { level: 'list', repo } : { level: 'sessions' }),
    ]
  }
  if (menu.level === 'new') {
    return [
      <Text dimColor>new session in</Text>,
      ...repos.map(repo => <Button key={`new-${label(repo)}`} plain label={label(repo)} onPress={() => c.onLevel({ level: 'name', repo, name: '' })} />),
      back({ level: 'sessions' }),
    ]
  }
  if (menu.level === 'name') {
    const { repo, name } = menu
    const problem = name.trim() ? nameProblem(name, of(repo)) : null
    return [
      ...noTerminal(kit, c),
      <Text dimColor>{`new ${label(repo)} session`}</Text>,
      Input ? (
        <Input
          key="session-name"
          label="name"
          placeholder="e.g. login-fix"
          value={name}
          submitLabel={c.terminal.hasWt ? 'Create' : 'Show command'}
          autoFocus
          onInput={value => c.onName(repo, value)}
          onSubmit={value => c.onCreate(repo, value)}
        />
      ) : (
        <Text dimColor>create sessions from the terminal or the desktop app</Text>
      ),
      problem ? (
        <Text color="yellow">{problem}</Text>
      ) : (
        <Text dimColor>{`letters, digits, - _ . · Enter ${c.terminal.hasWt ? 'creates it' : 'shows the command'}`}</Text>
      ),
      back({ level: 'new' }),
    ]
  }
  if (menu.level === 'command') {
    return [
      <Text color="yellow">{NO_WT}</Text>,
      <Text dimColor>{`${menu.title}: run this in a terminal`}</Text>,
      <Text bold>{menu.command}</Text>,
      back(menu.back),
    ]
  }
  return []
}

/** The menu button at the top right, and under it the menu while open. */
function PanelMenuButton(kit: PaneKit, c: MenuControl) {
  const { Box } = kit
  const isOpen = c.menu.level !== 'closed'
  return (
    <Box flexDirection="column" alignItems="flex-end">
      {IconButton(kit, { key: 'menu', glyph: '☰', hint: 'sessions and skills', hotkey: 'm', isLit: isOpen, onPress: c.onToggle })}
      {isOpen && (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          {menuBody(kit, c)}
        </Box>
      )}
    </Box>
  )
}

export type LinkControl = {
  state: LinkState
  /** The other open sessions, of any repository. */
  candidates: readonly SessionEntry[]
  labels: Readonly<Record<Repo, string>>
  isOpen: boolean
  onToggle: () => void
  onPick: (entry: SessionEntry) => void
  onUnlink: () => void
}

/**
 * An icon button with its hint: the hint shows beside it (to its left, or to
 * its right for an icon at the left edge) while the pointer is over it,
 * painted over the row so nothing moves.
 */
function IconButton(
  { Box, Text, Button }: PaneKit,
  icon: { key: string; glyph: string; hint: string; hotkey?: string; isLit?: boolean; hintRight?: boolean; onPress: () => void },
) {
  const offset = icon.glyph.length + 5
  return (
    <Box key={`${icon.key}-hover`} flexDirection="row">
      <Box display="none" hover={{ display: 'flex' }} position="absolute" {...(icon.hintRight ? { left: offset } : { right: offset })}>
        <Text dimColor wrap="truncate-end">
          {icon.hint}
        </Text>
      </Box>
      <Button
        key={icon.key}
        label={icon.glyph}
        hotkey={icon.hotkey}
        variant={icon.isLit ? 'primary' : 'secondary'}
        onPress={icon.onPress}
      />
    </Box>
  )
}

/** How the link names a session: its repository, then its name. */
function sessionTitle(labels: Readonly<Record<Repo, string>>, repo: Repo | null, who: string): string {
  return repo ? `${labelOf(labels, repo)} · ${who}` : `no repository · ${who}`
}

/**
 * The session link: an icon, lit while linked, its hint saying with whom; it
 * opens, under it, every other open session to link with, by repository, and unlink.
 */
function LinkMenu(kit: PaneKit, link: LinkControl) {
  const { Box, Text, Button } = kit
  const state = link.state
  const partner = state.partner
  const who = partner ? sessionTitle(link.labels, partner.repo, partner.name ?? shortId(partner.sessionId)) : ''
  const stands = partner ? (partner.isLive ? ` · linked with ${who}` : ` · waiting for ${who}…`) : ''
  const groups = [...new Set(link.candidates.map(entry => entry.repo))]
  return (
    <Box flexDirection="column" alignItems="flex-start">
      <Box flexDirection="row" columnGap={1}>
        {IconButton(kit, {
          key: 'link',
          glyph: '⇄',
          hint: `Link with another session${stands}`,
          hotkey: 'l',
          isLit: state.linked,
          hintRight: true,
          onPress: link.onToggle,
        })}
        {/* Waiting is worth seeing without the pointer: the partner is not open. */}
        {partner && !partner.isLive && <Text color="yellow">{`waiting for ${who}…`}</Text>}
      </Box>
      {link.isOpen && (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Text dimColor>link with another session</Text>
          {link.candidates.length === 0 ? (
            <Text dimColor>no other session open</Text>
          ) : (
            groups.flatMap(repo => [
              <Text bold>{repo ? labelOf(link.labels, repo) : 'no repository'}</Text>,
              ...link.candidates
                .filter(entry => entry.repo === repo)
                .map(entry => (
                  <Button
                    key={`link-${shortId(entry.sessionId)}`}
                    plain
                    label={`${partner?.sessionId === entry.sessionId ? '✓' : ' '} ${entryLabel(entry)}`}
                    onPress={() => link.onPick(entry)}
                  />
                )),
            ])
          )}
          {partner && <Button key="unlink" plain dimColor label="unlink" onPress={link.onUnlink} />}
        </Box>
      )}
    </Box>
  )
}

/** An opened file's changes: green added lines, red removed, as a diff is drawn. */
function DiffBlock({ Box, Text, Code }: PaneKit, diff: DiffView) {
  if (diff.status === 'loading') return <Text dimColor>reading changes…</Text>
  if (diff.status !== 'ready' || !diff.source) return <Text dimColor>{diff.note ?? 'no changes'}</Text>
  return (
    <Box flexDirection="column">
      {diff.note && <Text color="yellow">{diff.note}</Text>}
      <Code source={diff.source} format="diff" path={diff.file} wrap="truncate-end" />
      {diff.omitted ? <Text dimColor>{`… ${diff.omitted} more change blocks not shown`}</Text> : null}
    </Box>
  )
}

/** The pane a file's changes open in: which file, its changes, and a way back. */
export function changesPane(kit: PaneKit, diff: DiffView | null, labels: Readonly<Record<Repo, string>>, onClose: () => void) {
  const { Box, Text, Button } = kit
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text bold wrap="truncate-start">
          {diff ? `${labelOf(labels, diff.repo)}/${diff.file}` : 'no file open'}
        </Text>
        <Button key="close-changes" label="close" role="dismiss" onPress={onClose} />
      </Box>
      {diff ? DiffBlock(kit, diff) : <Text dimColor>{`Press changes next to a modified file in the ${TITLE} panel.`}</Text>}
    </Box>
  )
}

/** The detailed pane: the session's repository, its workflow, and the files modified in each repository. */
export function pane(
  kit: PaneKit,
  view: View,
  diff: DiffView | null,
  reverted: readonly string[],
  rows: number,
  menu: MenuControl,
  onFile: (repo: Repo, file: string) => void,
  link: LinkControl,
) {
  const { tracker, git, cwdRepo, roots, labels, work, now } = view
  const { Box, Text, Button } = kit
  const repos = activeRepos(tracker, cwdRepo)
  const status = verification(tracker)
  const validation = tracker.validation
  const activityRoom = Math.max(3, rows - 20)

  return (
    <Box flexDirection="column" gap={1}>
      {/* The title across the pane, centred; under it the repository and the link left, the menu right. */}
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="center">
          <Text bold color="cyan">
            {TITLE}
          </Text>
        </Box>
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Box flexDirection="row" columnGap={2} alignItems="flex-start">
            <Text bold color="cyan">
              {cwdRepo ? `● ${labelOf(labels, cwdRepo)}` : '○ no repository'}
            </Text>
            {LinkMenu(kit, link)}
          </Box>
          {PanelMenuButton(kit, menu)}
        </Box>
      </Box>

      <Box flexDirection="column">
        {Heading(kit, 'Session')}
        <Text wrap="truncate-end">
          <Text dimColor>Repository </Text>
          {cwdRepo ? (
            <Text>
              <Text bold>{labelOf(labels, cwdRepo)}</Text>
              <Text dimColor>{`  ${roots[cwdRepo] ?? ''}`}</Text>
            </Text>
          ) : (
            <Text dimColor>— (session outside any Git repository)</Text>
          )}
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>Branch     </Text>
          {cwdRepo ? <Text bold>{branchText(git[cwdRepo])}</Text> : <Text dimColor>—</Text>}
        </Text>
        {AgentList(kit, agentRows(tracker, work, now))}
      </Box>

      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {Heading(kit, `Workflow · cycle ${tracker.cycle}`)}
          {PhaseColumn(kit, tracker, !work.isWorking)}
          <Text dimColor>
            {tracker.phaseSource === 'agent'
              ? 'phase from the workflow subagent'
              : tracker.phaseSource === 'inferred'
                ? 'phase inferred from activity'
                : 'no workflow activity yet'}
          </Text>
        </Box>

        <Box flexDirection="column">
          {Heading(kit, 'Verification')}
          <Text color={TONE_COLOR[status.tone]} dimColor={status.tone === 'muted'}>
            {status.label}
          </Text>
          {validation && (
            <Text dimColor wrap="truncate-end">
              {`${validation.isInterrupted ? '■' : validation.isOk ? '✓' : '✗'} ${validation.command}`}
            </Text>
          )}
          {tracker.verifier && (
            <Text dimColor>
              {`verifier: ${tracker.verifier.verdict}${tracker.verifier.seq < tracker.lastEditSeq ? ' (stale: edited since)' : ''}`}
            </Text>
          )}
        </Box>
      </Box>

      {fileRepos(tracker, cwdRepo, roots).map(repo => {
        // Files put back as they were at the start of the session have no changes left to show.
        const files = (tracker.files[repo] ?? []).filter(file => !reverted.includes(`${repo}:${file}`))
        const isActive = repos.includes(repo)
        const key = labelOf(labels, repo)
        return (
          <Box flexDirection="column">
            <Text bold underline dimColor={!isActive} wrap="truncate-end">
              {repo === cwdRepo ? `${labelOf(labels, repo)} · modified files` : `${labelOf(labels, repo)} · ${branchText(git[repo])} · modified files`}
            </Text>
            {files.length === 0 && <Text dimColor>no files modified in this session</Text>}
            {files.slice(0, FILE_LIMIT).map((file, index) => {
              const isOpen = diff?.repo === repo && diff.file === file
              return (
                <Box flexDirection="column">
                  {/* A path the terminal opens in the editor; the button beside it opens the changes in their own pane. */}
                  <Box flexDirection="row" columnGap={1}>
                    <Button
                      key={`file-${key}-${index}`}
                      label="changes"
                      variant={isOpen ? 'primary' : 'secondary'}
                      onPress={() => onFile(repo, file)}
                    />
                    <Text wrap="truncate-start" bold={isOpen}>
                      {file}
                    </Text>
                  </Box>
                </Box>
              )
            })}
            {files.length > FILE_LIMIT && <Text dimColor>{`  … ${files.length - FILE_LIMIT} more`}</Text>}
          </Box>
        )
      })}

      <Box flexDirection="column">
        {Heading(kit, 'Recent activity')}
        {tracker.activity.length === 0 && <Text dimColor>nothing yet</Text>}
        {tracker.activity.slice(-activityRoom).map(entry => (
          <Text wrap="truncate-end">
            <Text dimColor>{`${entry.actor === 'Main Claude' ? 'main' : entry.actor}  `}</Text>
            <Text>{entry.text}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  )
}
