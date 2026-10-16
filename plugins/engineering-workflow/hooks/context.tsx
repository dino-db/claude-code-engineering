import type { ContextState } from '../types'
import type { PaneKit } from './view'

/*
 * The context window, at the foot of the pane. The two actions the mod takes
 * beyond observing are here, each on a press alone: compacting the
 * conversation, and emptying Claude Code's local caches.
 */

/** Rows the block takes under the rest of the pane: rule, marker, context, message. */
export const CONTEXT_ROWS = 4

export const EMPTY_CONTEXT: ContextState = { context: null, message: null, isBusy: false }

/** What the clean button empties, under `~/.claude` (`%USERPROFILE%\.claude` on Windows). */
export const CACHE_DIRS = ['cache', 'paste-cache']
export const CACHE_FILES = ['stats-cache.json']
const BAR_MAX = 20
const FULL_CELL = '■'
const EMPTY_CELL = '□'

const CLEAN_SCRIPT = [
  "$d = Join-Path $env:USERPROFILE '.claude'",
  '$n = 0',
  `foreach ($f in ${CACHE_DIRS.map(d => `'${d}'`).join(',')}) {`,
  '  $p = Join-Path $d $f',
  '  if (Test-Path $p) { Get-ChildItem $p -Force | ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue; $n++ } }',
  '}',
  `foreach ($f in ${CACHE_FILES.map(f => `'${f}'`).join(',')}) {`,
  '  $p = Join-Path $d $f',
  '  if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue; $n++ }',
  '}',
  'Write-Output $n',
].join('\n')

export const CLEAN_ARGV = ['powershell', '-NoProfile', '-NonInteractive', '-Command', CLEAN_SCRIPT]

/** The same on macOS and Linux, with `sh`: prints how many entries it removed. */
const POSIX_CLEAN_SCRIPT = [
  'd="$HOME/.claude"',
  'n=0',
  `for f in ${CACHE_DIRS.join(' ')}; do`,
  '  if [ -d "$d/$f" ]; then',
  '    for e in "$d/$f"/* "$d/$f"/.[!.]*; do [ -e "$e" ] && rm -rf "$e" && n=$((n+1)); done',
  '  fi',
  'done',
  `for f in ${CACHE_FILES.join(' ')}; do`,
  '  [ -f "$d/$f" ] && rm -f "$d/$f" && n=$((n+1))',
  'done',
  'echo "$n"',
].join('\n')

export const POSIX_CLEAN_ARGV = ['sh', '-c', POSIX_CLEAN_SCRIPT]

export function cleanArgv(isWindows: boolean): string[] {
  return isWindows ? CLEAN_ARGV : POSIX_CLEAN_ARGV
}

export function formatTokens(n: number | null): string {
  if (n === null) return '?'
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
}

export function formatBytes(n: number | null): string {
  if (n === null) return '?'
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function zoneColor(fraction: number): string {
  return fraction >= 0.8 ? 'red' : fraction >= 0.5 ? 'yellow' : 'green'
}

/** Filled up to the percentage, empty after; green below 50%, yellow below 80%, red above. */
function barSegments(pct: number, width: number): { text: string; color: string; isEmpty: boolean }[] {
  const filled = Math.round((pct / 100) * width)
  const segments: { text: string; color: string; isEmpty: boolean }[] = []
  for (let i = 0; i < width; i++) {
    const color = zoneColor(i / width)
    const isEmpty = i >= filled
    const last = segments[segments.length - 1]
    if (last && last.color === color && last.isEmpty === isEmpty) last.text += isEmpty ? EMPTY_CELL : FULL_CELL
    else segments.push({ text: isEmpty ? EMPTY_CELL : FULL_CELL, color, isEmpty })
  }
  return segments
}

/** The block itself, under a rule across the pane. */
export function ContextBlock(kit: PaneKit, state: ContextState, columns: number, onCompact: () => void, onClean: () => void) {
  const { Box, Text, Button } = kit
  const ctx = state.context
  const pct = ctx?.percent ?? null
  const width = Math.max(10, Math.min(BAR_MAX, columns - 14))
  const label = 'Context '

  const pos = pct === null ? 0 : Math.min(width - 1, Math.round((pct / 100) * width))
  const marker = pct === null ? '' : `${' '.repeat(label.length + pos)}▼ ${pct}%`
  const detail = ctx === null ? 'waiting...' : `${formatTokens(ctx.tokens)}/${formatTokens(ctx.window)}`

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{'─'.repeat(Math.max(1, columns))}</Text>
      {pct === null ? null : (
        <Text color={zoneColor(pct / 100)} bold>
          {marker}
        </Text>
      )}
      <Box>
        <Text bold>{label}</Text>
        {barSegments(pct ?? 0, width).map(s => (
          <Text color={s.color} dimColor={s.isEmpty}>
            {s.text}
          </Text>
        ))}
        <Text dimColor> {detail} </Text>
        <Button key="compact" label="Compact" hotkey="k" onPress={onCompact} />
        <Text> </Text>
        <Button key="clean" label="Clear cache" hotkey="x" onPress={onClean} />
      </Box>
      {state.message ? <Text dimColor>{state.message}</Text> : null}
    </Box>
  )
}
