/** A repository, by the normalized, lower-cased path of its Git toplevel. */
export type Repo = string

/** The repositories the session knows, each its root as Git spells it, in the order they became known. */
export type RepoRoots = Record<Repo, string>

export type Phase = 'explore' | 'plan' | 'implement' | 'verify'

export type Verdict = 'PASS' | 'CONDITIONAL PASS' | 'FAIL' | 'UNKNOWN'

/** A subagent that has started and not yet finished. */
export type AgentRun = {
  /** The Agent call's tool_use_id: known before the agent's own id. */
  key: string
  agentId?: string
  type: string
  description: string
  isBackground: boolean
  /** When it started, for the time the pane shows it running. */
  startedAt?: number
}

export type Validation = {
  command: string
  isOk: boolean
  /** Stopped by the person: skipped, not failed. */
  isInterrupted?: boolean
  seq: number
  repo: Repo | null
}

export type Activity = {
  at: number
  actor: string
  text: string
}

export type Tracker = {
  /** Monotonic counter of observed events; orders edits, validations and verdicts. */
  seq: number
  cycle: number
  phase: Phase | null
  /** Phases visited in the current cycle, in order. */
  reached: Phase[]
  /** Whether the current phase came from a workflow subagent or was inferred. */
  phaseSource: 'agent' | 'inferred' | null
  /** The main turn in which the phase last changed. */
  phaseTurn: string | null
  turnId: string | null
  cycleRepos: Repo[]
  cycleEdits: number
  /** Files edited in the current cycle, by repository. */
  cycleFiles: Record<Repo, string[]>
  lastEditSeq: number
  /** Files modified through tools in this session, relative to their repository. */
  files: Record<Repo, string[]>
  validation: Validation | null
  verifier: { verdict: Verdict; seq: number } | null
  agents: AgentRun[]
  activity: Activity[]
}

export type RepoGit = {
  branch: string | null
  /** Entries of `git status --porcelain`; null when unknown. */
  dirty: number | null
  error?: string
}

export type GitInfo = Record<Repo, RepoGit | null>

/** One session's file in the shared registry the session switcher reads. */
export type SessionEntry = {
  sessionId: string
  /** Its repository; null for a session outside any Git repository. */
  repo: Repo | null
  /** That repository's root, for another session to start or attach one there. */
  repoRoot?: string | null
  cwd: string
  /** The name the sessions menu gave it (EW_SESSION_NAME); null for a session opened by hand. */
  name: string | null
  /** The named Windows Terminal window the session runs in, when the menu opened it. */
  window: string | null
  /** Its claude process (CLAUDE_PID), what closing a session in a window ends; null when unknown. */
  pid: number | null
  updatedAt: number
  isOpen: boolean
  /** Runs in the background (the claude daemon): in no window, so it cannot be shown. */
  background?: boolean
}

/** The modified file opened in the pane, and its changes once read. */
export type DiffView = {
  repo: Repo
  file: string
  status: 'loading' | 'ready' | 'empty' | 'error'
  source?: string
  /** Hunks left out to fit the pane. */
  omitted?: number
  note?: string
}

/**
 * Each edited file's state before its first edit in the session, by `repo:relative`:
 * a copy was kept (`saved`), or the file did not exist yet (`absent`).
 */
export type Baselines = Record<string, 'saved' | 'absent'>

/** Whether Main Claude is working on a turn, and how the last one ended. */
export type WorkState = {
  isWorking: boolean
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  outcome: 'answer' | 'aborted' | 'refusal' | 'error' | null
}

export type ContextInfo = { percent: number | null; tokens: number | null; window: number }

/** The context window block at the foot of the pane. */
export type ContextState = {
  context: ContextInfo | null
  /** What the last compact or clean came to. */
  message: string | null
  isBusy: boolean
}

/** One linked pair: two sessions, by id, in no order. */
export type LinkPair = { a: string; b: string }

/** What <temp>/engineering-workflow/link.json holds: the linked pairs. */
export type LinkFile = { pairs: LinkPair[]; updatedAt: number }

/** The session this one is paired with; `repo` null when it runs outside any Git repository. */
export type LinkPartner = { sessionId: string; repo: Repo | null; repoRoot: string | null; name: string | null; isLive: boolean }

/** The session link, as this session knows it. */
export type LinkState = {
  /** In a pair of link.json. */
  linked: boolean
  /** The other side of the pair, open or not; null while unpaired. */
  partner: LinkPartner | null
  /** Messages this session sent to the partner since it started. */
  sent: number
  /** Messages this session received from the partner since it started. */
  received: number
}

/** Where the pane's menu (☰) stands: its two entries, sessions and skills, and the levels under sessions. */
export type PanelMenu =
  | { level: 'closed' }
  | { level: 'main' }
  | { level: 'skills' }
  | { level: 'sessions' }
  | { level: 'list'; repo: Repo }
  | { level: 'new' }
  | { level: 'name'; repo: Repo; name: string }
  | { level: 'confirm'; entry: SessionEntry }
  /** Without Windows Terminal: the command that does what was pressed, to run by hand. */
  | { level: 'command'; title: string; command: string; back: PanelMenu }

/** Whether the sessions menu can run Windows Terminal, and which platform the session runs on. */
export type TerminalInfo = { isWindows: boolean; hasWt: boolean }

/** A slash command one of the session repository's skills gives. */
export type SkillAction = { name: string; takesArgument: boolean }

declare module 'claude-code' {
  interface PluginState {
    'engineering-workflow': {
      /** The repositories the session knows: its own first, then each one it edited. */
      repos: RepoRoots
      tracker: Tracker
      git: GitInfo
      diff: DiffView | null
      baselines: Baselines
      /** Files edited and then put back as they were at the start of the session, by `repo:relative`. */
      reverted: string[]
      /** The session repository's skills, for the pane's action buttons. */
      skills: SkillAction[]
      /** Why the Actions menu has no skills, when it has none in a repository session. */
      skillsNote: string | null
      /** Main Claude's turn: working, or how the last one ended. */
      work: WorkState
      /** The time while a turn runs, ticking so the elapsed time redraws. */
      now: number
      /** The context window and cache, at the foot of the pane. */
      context: ContextState
      /** Whether the sessions menu can run Windows Terminal. */
      terminal: TerminalInfo
      /** The link with another session. */
      link: LinkState
      /** The open sessions of every repository, for the menus. */
      sessions: SessionEntry[]
      /** Where the pane's menu (sessions and skills) stands. */
      menu: PanelMenu
      /** Whether the link menu is open. */
      linkMenuOpen: boolean
    }
  }
}
