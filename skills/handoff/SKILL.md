---
name: handoff
description: Compact the current conversation into a handoff document for another agent to continue the work efficiently.
argument-hint: "What will the next session focus on?"
user-invocable: true
---

Create a concise but technically complete handoff document summarizing the current session.

The handoff should allow a fresh agent to immediately continue the work with minimal additional context.

Save the handoff document to the user's OS temporary directory, not the current workspace.

Prioritize:
- current implementation state
- architectural decisions
- active blockers
- failed approaches already explored
- pending next steps
- relevant files and commands

Include:
- current objective
- progress summary
- blockers and risks
- exact next steps
- validation/testing commands
- suggested skills for the next session

If the user provided arguments, treat them as the intended focus of the next session and tailor the handoff accordingly.

Avoid:
- redundant explanations
- conversational filler
- duplicating existing artifacts
- repeating information already captured in:
  - PRDs
  - ADRs
  - issue trackers
  - plans
  - commits
  - git diffs

Instead, reference those artifacts by path or URL.

Redact:
- API keys
- passwords
- secrets
- tokens
- personally identifiable information

The resulting handoff should be:
- concise
- actionable
- technically dense
- optimized for fast session resumption
