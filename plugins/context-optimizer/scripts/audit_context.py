"""Read-only heuristic audit of Claude Code Markdown instruction files."""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

MAX_BYTES = 512_000
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__"}


def candidates(root: Path):
    """Yield instruction files inside root without following directory symlinks."""
    import os

    for base, dirs, files in os.walk(root, followlinks=False):
        current = Path(base)
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not (current / d).is_symlink()]
        relative = current.relative_to(root)
        for filename in files:
            path = current / filename
            if path.is_symlink() or not path.is_file():
                continue
            if filename in {"CLAUDE.md", "AGENTS.md"} or (".claude" in relative.parts and filename.endswith(".md")):
                yield path


def normalize(line: str) -> str:
    """Normalize whitespace and bullet prefixes for duplicate detection."""
    return re.sub(r"\s+", " ", re.sub(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", "", line)).strip().casefold()


def audit(root: Path, threshold: int = 160) -> dict:
    """Return file metrics and exact normalized repeated lines, without writes."""
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Root must be a directory")
    metrics = []
    occurrences = defaultdict(list)
    for path in sorted(candidates(root)):
        rel = path.relative_to(root).as_posix()
        if path.stat().st_size > MAX_BYTES:
            metrics.append({"file": rel, "skipped": "file exceeds 512 KB"})
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeError, OSError):
            metrics.append({"file": rel, "skipped": "cannot read UTF-8"})
            continue
        lines = content.splitlines()
        metrics.append({"file": rel, "lines": len(lines), "estimated_tokens": round(len(content) / 4), "long": len(lines) > threshold})
        for number, line in enumerate(lines, 1):
            stripped = line.strip()
            if len(stripped) < 28 or stripped.startswith(("#", "```", "---", "<!--")):
                continue
            normalized = normalize(line)
            if len(normalized) >= 28:
                occurrences[normalized].append({"file": rel, "line": number})
    repeated = [
        {"text": value[:180], "locations": locs}
        for value, locs in occurrences.items()
        if len({location["file"] for location in locs}) > 1
    ]
    repeated.sort(key=lambda item: (-len(item["locations"]), item["text"]))
    return {"root": str(root), "files": metrics, "cross_file_repeated_lines": repeated,
            "limitations": "Approximate tokens (characters/4); exact normalized line matches only. No semantic or scope analysis."}


def main() -> None:
    """Print the audit as JSON or a compact human-readable summary."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--threshold", type=int, default=160)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = audit(Path(args.root), args.threshold)
    if args.json:
        print(json.dumps(result, indent=2))
        return
    print("Context Optimizer — read-only audit")
    for entry in result["files"]:
        if "skipped" in entry:
            print(f"  {entry['file']}: skipped ({entry['skipped']})")
        else:
            print(f"  {entry['file']}: {entry['lines']} lines, ~{entry['estimated_tokens']} tokens" + (" [LONG]" if entry["long"] else ""))
    print(f"Cross-file repeated lines: {len(result['cross_file_repeated_lines'])}")
    for item in result["cross_file_repeated_lines"][:20]:
        locations = ", ".join(f"{loc['file']}:{loc['line']}" for loc in item["locations"])
        print(f"  {locations}: {item['text']}")
    print(result["limitations"])


if __name__ == "__main__":
    main()
