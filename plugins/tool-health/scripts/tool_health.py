"""tool-health: remember tools that fail for structural reasons in this environment.

Hooks feed tool failures in; SessionStart injects the active entries as context so
Claude does not pay the same failed calls again. Advisory only: nothing is blocked
or rewritten, and the only file written is the plugin's own state file.

Usage:
    tool_health.py hook                  read a hook event as JSON on stdin
    tool_health.py status [--json]       list recorded entries
    tool_health.py reset [KEY]           remove all entries, or those matching KEY
Common option: --data-dir DIR (default: $CLAUDE_PLUGIN_DATA, else <temp>/tool-health)
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

STATE_VERSION = 1
STATE_FILE = "state.json"
DEFAULT_TTL_DAYS = 7
MAX_CONTEXT_ENTRIES = 15
DETAIL_LIMIT = 160
MACHINE = "machine"

# Failures caused by the user or by Claude Code's own policy, never by the tool.
IGNORED = re.compile(
    r"doesn't want to proceed|user (?:rejected|denied|declined)|permission[^\n]{0,60}denied"
    r"|denied by|blocked by[^\n]{0,20}hook|interrupted by (?:the )?user|request interrupted",
    re.I,
)
API_ERROR = re.compile(r"API Error:\s*(\d{3})")
UNSUPPORTED = re.compile(
    r"does not match any of the expected tags|not supported|unsupported|unknown tool"
    r"|not enabled|is not available|extra inputs are not permitted",
    re.I,
)
NO_SUCH_TOOL = re.compile(r"No such tool available:\s*([\w.:-]+)")
MCP_DOWN = re.compile(
    r"not connected|connection closed|ECONNREFUSED|server[^\n]{0,40}(?:not found|failed|disconnected)"
    r"|failed to connect",
    re.I,
)
MISSING_COMMAND = (
    re.compile(r"(?:^|[\s:])([A-Za-z0-9_.+-]+): command not found", re.M),  # bash, sh
    re.compile(r"command not found: ([A-Za-z0-9_.+-]+)"),  # zsh
    re.compile(r"'([A-Za-z0-9_.+-]+)' is not recognized as an internal or external command"),  # cmd
    re.compile(r"The term '([A-Za-z0-9_.+-]+)' is not recognized as"),  # PowerShell
)
SECRET = re.compile(r"(?i)(bearer\s+|api[_-]?key[\"']?\s*[=:]\s*[\"']?|token[\"']?\s*[=:]\s*[\"']?)[^\s\"',}]+")
LONG_TOKEN = re.compile(r"[A-Za-z0-9+/_-]{32,}")
COMMAND_SPLIT = re.compile(r"&&|\|\||[;|\n]|\$\(|`")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
PREFIX_WORDS = {"sudo", "exec", "time", "nohup", "command", "env"}


# --------------------------------------------------------------------------- environment

def provider_key(environ) -> str:
    """Identify the API provider without exposing credentials or full URLs."""
    for var, name in (
        ("CLAUDE_CODE_USE_BEDROCK", "bedrock"),
        ("CLAUDE_CODE_USE_VERTEX", "vertex"),
        ("CLAUDE_CODE_USE_FOUNDRY", "foundry"),
    ):
        if environ.get(var, "").strip().lower() in ("1", "true", "yes"):
            return name
    base = environ.get("ANTHROPIC_BASE_URL", "").strip()
    if base:
        try:
            host = urlparse(base if "://" in base else "https://" + base).hostname
        except ValueError:
            host = None
        if host:
            return "gateway:" + host.lower()
    return "anthropic"


def data_dir(environ, override: str | None = None) -> Path:
    if override:
        return Path(override)
    if environ.get("CLAUDE_PLUGIN_DATA"):
        return Path(environ["CLAUDE_PLUGIN_DATA"])
    return Path(tempfile.gettempdir()) / "tool-health"


def ttl_seconds(environ) -> float:
    try:
        days = float(environ.get("TOOL_HEALTH_TTL_DAYS", DEFAULT_TTL_DAYS))
    except ValueError:
        days = DEFAULT_TTL_DAYS
    return max(days, 0.0) * 86400


# --------------------------------------------------------------------------- classification

def _detail(text: str) -> str:
    """First meaningful line of an error, with secrets redacted and length capped."""
    lines = [line.strip() for line in str(text).splitlines()]
    meaningful = [line for line in lines if line and not re.fullmatch(r"Exit code \d+", line)]
    line = re.sub(r"\s+", " ", meaningful[0] if meaningful else "")
    line = LONG_TOKEN.sub("<redacted>", SECRET.sub(r"\1<redacted>", line))
    return line if len(line) <= DETAIL_LIMIT else line[: DETAIL_LIMIT - 3] + "..."


def missing_commands(text: str) -> list[str]:
    """Command names a shell reported as not found, in order of appearance."""
    found: list[str] = []
    for pattern in MISSING_COMMAND:
        for match in pattern.finditer(text or ""):
            name = match.group(1)
            if name not in found and name.lower() not in ("line", "bash", "sh", "zsh"):
                found.append(name)
    return found


def _finding(kind: str, scope: str, tool: str, subject: str, key: str, text: str) -> dict:
    return {"kind": kind, "scope": scope, "tool": tool, "subject": subject, "key": key, "detail": _detail(text)}


def classify(tool_name: str, error: str, is_interrupt: bool = False) -> list[dict]:
    """Structural findings in a tool error. Transient and user-caused failures give []."""
    if is_interrupt or not error or IGNORED.search(error):
        return []
    tool_name = tool_name or "?"

    if tool_name.startswith("mcp__"):
        server = tool_name.split("__")[1] if tool_name.count("__") >= 2 else tool_name[5:]
        if MCP_DOWN.search(error):
            return [_finding("mcp_unavailable", MACHINE, tool_name, server, "mcp:" + server, error)]
        return []

    api = API_ERROR.search(error)
    if api:
        status = int(api.group(1))
        if status == 403:
            return [_finding("forbidden", "provider", tool_name, tool_name, "tool:" + tool_name, error)]
        if status == 404 or (status == 400 and UNSUPPORTED.search(error)):
            return [_finding("unsupported", "provider", tool_name, tool_name, "tool:" + tool_name, error)]
        return []  # 429, 5xx, ordinary 400s: transient or caused by the input

    no_tool = NO_SUCH_TOOL.search(error)
    if no_tool:
        name = no_tool.group(1)
        return [_finding("unavailable", "provider", name, name, "tool:" + name, error)]

    if tool_name == "Bash":
        return command_findings(error)
    return []


def command_findings(text: str) -> list[dict]:
    return [
        _finding("command_missing", MACHINE, "Bash", name, "cmd:" + name, _line_with(text, name))
        for name in missing_commands(text)
    ]


def _line_with(text: str, needle: str) -> str:
    for line in text.splitlines():
        if needle in line and "not" in line:
            return line
    return text


def invoked_commands(command: str) -> set[str]:
    """First word of each simple command in a shell line (best effort)."""
    names: set[str] = set()
    for segment in COMMAND_SPLIT.split(command or ""):
        words = segment.strip().lstrip("({!").split()
        while words and (ASSIGNMENT.match(words[0]) or words[0] in PREFIX_WORDS):
            words.pop(0)
        if words:
            names.add(os.path.basename(words[0].strip("\"'")))
    return names


def bash_output(response) -> str:
    if isinstance(response, dict):
        return "\n".join(str(response.get(field) or "") for field in ("stdout", "stderr"))
    return str(response or "")


# --------------------------------------------------------------------------- state

def empty_state() -> dict:
    return {"version": STATE_VERSION, "entries": {}}


def load_state(directory: Path) -> dict:
    try:
        state = json.loads((directory / STATE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return empty_state()
    if not isinstance(state, dict) or not isinstance(state.get("entries"), dict):
        return empty_state()
    return state


def save_state(directory: Path, state: dict) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".json", dir=str(directory))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2, sort_keys=True)
        os.replace(tmp, directory / STATE_FILE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def entry_id(env: str, key: str) -> str:
    return env + "|" + key


def record(state: dict, findings: list[dict], provider: str, now: float) -> bool:
    entries = state["entries"]
    for finding in findings:
        env = MACHINE if finding["scope"] == MACHINE else provider
        ident = entry_id(env, finding["key"])
        entry = entries.get(ident)
        if entry is None:
            entry = dict(finding, env=env, first_seen=now, count=0)
            entries[ident] = entry
        entry.update(detail=finding["detail"], tool=finding["tool"], kind=finding["kind"], last_seen=now)
        entry["count"] = int(entry.get("count", 0)) + 1
    return bool(findings)


def success_keys(tool_name: str, tool_input, provider: str) -> list[str]:
    """Entry ids that a successful call of this tool proves wrong."""
    ids = [entry_id(provider, "tool:" + tool_name)]
    if tool_name.startswith("mcp__") and tool_name.count("__") >= 2:
        ids.append(entry_id(MACHINE, "mcp:" + tool_name.split("__")[1]))
    if tool_name == "Bash" and isinstance(tool_input, dict):
        ids += [entry_id(MACHINE, "cmd:" + name) for name in invoked_commands(str(tool_input.get("command", "")))]
    return ids


def clear(state: dict, ids) -> bool:
    removed = [ident for ident in ids if ident in state["entries"]]
    for ident in removed:
        del state["entries"][ident]
    return bool(removed)


def prune(state: dict, now: float, ttl: float) -> bool:
    expired = [ident for ident, entry in state["entries"].items() if float(entry.get("last_seen", 0)) < now - ttl]
    return clear(state, expired)


def active_entries(state: dict, provider: str) -> list[dict]:
    entries = [entry for entry in state["entries"].values() if entry.get("env") in (MACHINE, provider)]
    return sorted(entries, key=lambda entry: float(entry.get("last_seen", 0)), reverse=True)


# --------------------------------------------------------------------------- context

def advice(entry: dict) -> str:
    kind, subject = entry.get("kind"), entry.get("subject", "?")
    if kind == "command_missing":
        return f"`{subject}` is not installed or not on PATH: use another available tool, or ask the user to install it."
    if kind == "mcp_unavailable":
        return f"MCP server `{subject}` was unreachable: don't call its tools unless the user says it is back (`/mcp` shows its status)."
    if kind == "forbidden":
        return f"`{subject}` is refused by the API provider here (403): don't call it; tell the user if it is essential."
    alternative = " Use WebFetch on known URLs instead." if subject == "WebSearch" else ""
    return f"`{subject}` is not supported by the API provider here: don't call it.{alternative}"


def _day(timestamp) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(float(timestamp or 0)))


def render_context(state: dict, provider: str) -> str:
    entries = active_entries(state, provider)
    if not entries:
        return ""
    lines = [
        "tool-health: these tools failed for structural reasons in recent sessions in this environment "
        f"(provider: {provider}). Don't retry them blindly; use the alternative. If the user says a problem "
        "is fixed, try once: a success clears the entry. `/tool-health:status` lists or resets entries."
    ]
    for entry in entries[:MAX_CONTEXT_ENTRIES]:
        lines.append(
            f"- {advice(entry)} (seen {entry.get('count', 1)}x, last {_day(entry.get('last_seen'))}; "
            f"error: {entry.get('detail', '')})"
        )
    if len(entries) > MAX_CONTEXT_ENTRIES:
        lines.append(f"- ... and {len(entries) - MAX_CONTEXT_ENTRIES} more.")
    return "\n".join(lines)


# --------------------------------------------------------------------------- hook dispatch

def handle_event(event: dict, state: dict, provider: str, now: float, ttl: float) -> tuple[bool, str]:
    """Apply one hook event to the state. Returns (state changed, text to print)."""
    name = event.get("hook_event_name")
    tool_name = str(event.get("tool_name") or "")

    if name == "PostToolUseFailure":
        findings = classify(tool_name, str(event.get("error") or ""), bool(event.get("is_interrupt")))
        return record(state, findings, provider, now), ""

    if name == "PostToolUse":
        response = event.get("tool_response")
        tool_input = event.get("tool_input")
        if tool_name == "Bash":
            # A pipe can hide exit 127 (`gh ... | head` exits 0), so read the output too.
            findings = command_findings(bash_output(response))
            failed = {entry_id(MACHINE, finding["key"]) for finding in findings}
            changed = clear(state, [ident for ident in success_keys(tool_name, tool_input, provider)
                                    if ident not in failed])
            return record(state, findings, provider, now) or changed, ""
        if isinstance(response, str) and response.lstrip().startswith("API Error"):
            return record(state, classify(tool_name, response), provider, now), ""
        return clear(state, success_keys(tool_name, tool_input, provider)), ""

    if name == "SessionStart":
        changed = prune(state, now, ttl)
        context = render_context(state, provider)
        if not context:
            return changed, ""
        output = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context}}
        return changed, json.dumps(output)

    return False, ""


def run_hook(stdin, environ, directory: Path, now: float) -> str:
    event = json.loads(stdin.read() or "{}")
    if not isinstance(event, dict):
        return ""
    state_path = directory / STATE_FILE
    if event.get("hook_event_name") == "PostToolUse" and not state_path.exists():
        # Fast path for the common case: nothing recorded yet, unless Bash output shows a missing command.
        if event.get("tool_name") != "Bash" or not missing_commands(bash_output(event.get("tool_response"))):
            return ""
    state = load_state(directory)
    changed, output = handle_event(event, state, provider_key(environ), now, ttl_seconds(environ))
    if changed:
        save_state(directory, state)
    return output


# --------------------------------------------------------------------------- CLI

def format_status(state: dict, provider: str) -> str:
    entries = sorted(state["entries"].values(), key=lambda entry: float(entry.get("last_seen", 0)), reverse=True)
    if not entries:
        return f"tool-health: no entries recorded (current provider: {provider})."
    lines = [f"tool-health: {len(entries)} entr{'y' if len(entries) == 1 else 'ies'} (current provider: {provider})", ""]
    for entry in entries:
        env = entry.get("env", "?")
        marker = "*" if env in (MACHINE, provider) else " "
        lines.append(
            f"{marker} {entry.get('key')}  [{entry.get('kind')}, {env}]  seen {entry.get('count', 1)}x, "
            f"first {_day(entry.get('first_seen'))}, last {_day(entry.get('last_seen'))}"
        )
        lines.append(f"    {entry.get('detail', '')}")
    lines += ["", "* = applies to the current environment"]
    return "\n".join(lines)


def reset(state: dict, key: str | None) -> int:
    ids = [ident for ident, entry in state["entries"].items()
           if key is None or key in (entry.get("key"), entry.get("subject"), ident)]
    clear(state, ids)
    return len(ids)


def main(argv: list[str], stdin=sys.stdin, stdout=sys.stdout, environ=os.environ) -> int:
    args = list(argv)
    override = None
    if "--data-dir" in args:
        index = args.index("--data-dir")
        override = args[index + 1] if index + 1 < len(args) else None
        del args[index : index + 2]
    directory = data_dir(environ, override)
    command = args[0] if args else "status"

    if command == "hook":
        try:
            output = run_hook(stdin, environ, directory, time.time())
        except Exception:  # a hook must never disturb the session
            return 0
        if output:
            stdout.write(output + "\n")
        return 0

    state = load_state(directory)
    if command == "status":
        if "--json" in args:
            stdout.write(json.dumps(state, indent=2, sort_keys=True) + "\n")
        else:
            stdout.write(format_status(state, provider_key(environ)) + "\n")
        return 0
    if command == "reset":
        key = args[1] if len(args) > 1 else None
        removed = reset(state, key)
        if removed:
            save_state(directory, state)
        stdout.write(f"tool-health: removed {removed} entr{'y' if removed == 1 else 'ies'}.\n")
        return 0

    stdout.write(__doc__ or "")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
