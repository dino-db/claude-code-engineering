#!/bin/sh
# Run tool_health.py with whichever Python 3.8+ is available (python3 on macOS/Linux,
# often only python on Windows). Without Python, exit 0 so the session is never disturbed.
# The probe uses -c, so the hook's JSON on stdin stays unread for the real run.
dir=$(dirname "$0")
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 &&
     "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
    exec "$py" -I "$dir/tool_health.py" "$@"
  fi
done
exit 0
