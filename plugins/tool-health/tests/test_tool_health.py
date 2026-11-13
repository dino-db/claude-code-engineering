"""Tests for tool-health: classification, state, context and the hook entry point."""

import io
import json
import tempfile
import unittest
from pathlib import Path

from scripts import tool_health as th

# Real errors observed in a Claude Code session behind an API gateway.
WEBSEARCH_400 = (
    "API Error: 400 {\"message\":\"tools.0: Input tag 'web_search_20250305' found using 'type' does not "
    "match any of the expected tags: 'bash_20250124', 'custom', 'memory_20250818'\"}"
)
GH_MISSING = "/usr/bin/bash: line 1: gh: command not found"
USER_REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected."
NOW = 1_800_000_000.0
DAY = 86400.0


def failure(tool, error, **extra):
    return dict({"hook_event_name": "PostToolUseFailure", "tool_name": tool, "error": error}, **extra)


def success(tool, tool_input=None, response=None):
    return {"hook_event_name": "PostToolUse", "tool_name": tool, "tool_input": tool_input or {},
            "tool_response": response if response is not None else {}}


class ClassifyTests(unittest.TestCase):
    def test_gateway_rejecting_websearch_is_unsupported(self):
        [finding] = th.classify("WebSearch", WEBSEARCH_400)
        self.assertEqual((finding["kind"], finding["scope"], finding["key"]),
                         ("unsupported", "provider", "tool:WebSearch"))
        self.assertLessEqual(len(finding["detail"]), th.DETAIL_LIMIT)

    def test_transient_and_input_errors_are_ignored(self):
        for error in ("API Error: 429 rate limited", "API Error: 529 overloaded",
                      "API Error: 400 messages.0: text must be non-empty",
                      "Exit code 1\nFAILED tests/test_x.py::test_y", "Request failed with status code 404"):
            with self.subTest(error=error):
                self.assertEqual(th.classify("WebFetch" if "404" in error else "Bash", error), [])

    def test_user_rejection_and_interrupts_are_ignored(self):
        self.assertEqual(th.classify("WebFetch", USER_REJECTED), [])
        self.assertEqual(th.classify("WebSearch", WEBSEARCH_400, is_interrupt=True), [])
        self.assertEqual(th.classify("Bash", "Permission for this action was denied by the auto mode classifier"), [])

    def test_403_is_forbidden(self):
        [finding] = th.classify("WebFetch", "API Error: 403 forbidden for this model")
        self.assertEqual(finding["kind"], "forbidden")

    def test_missing_commands_across_shells(self):
        cases = {
            GH_MISSING: ["gh"],
            "Exit code 127\nzsh: command not found: jq": ["jq"],
            "'rg' is not recognized as an internal or external command,": ["rg"],
            "The term 'kubectl' is not recognized as a name of a cmdlet": ["kubectl"],
            "sh: 1: docker-compose: command not found\nbash: yq: command not found": ["docker-compose", "yq"],
        }
        for error, names in cases.items():
            with self.subTest(error=error):
                findings = th.classify("Bash", error)
                self.assertEqual([f["subject"] for f in findings], names)
                self.assertTrue(all(f["scope"] == th.MACHINE for f in findings))

    def test_mcp_server_down_is_keyed_by_server(self):
        [finding] = th.classify("mcp__github__create_issue", "MCP error: server github is not connected")
        self.assertEqual((finding["kind"], finding["key"]), ("mcp_unavailable", "mcp:github"))
        self.assertEqual(th.classify("mcp__github__create_issue", "Validation failed: title is required"), [])

    def test_secrets_are_redacted_from_detail(self):
        [finding] = th.classify("WebSearch", "API Error: 403 Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 denied key")
        self.assertNotIn("sk-ant-abcdefghijklmnop", finding["detail"])


class EnvironmentTests(unittest.TestCase):
    def test_provider_key_never_exposes_credentials_or_paths(self):
        key = th.provider_key({"ANTHROPIC_BASE_URL": "https://user:secret@Gateway.example.com/serving-endpoints/x"})
        self.assertEqual(key, "gateway:gateway.example.com")
        self.assertEqual(th.provider_key({"CLAUDE_CODE_USE_BEDROCK": "1"}), "bedrock")
        self.assertEqual(th.provider_key({}), "anthropic")

    def test_invoked_commands(self):
        self.assertEqual(th.invoked_commands("cd x && FOO=1 gh api repos | head -5; sudo /usr/bin/jq ."),
                         {"cd", "gh", "head", "jq"})


class HookFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.env = {"ANTHROPIC_BASE_URL": "https://gw.example.com"}

    def tearDown(self):
        self.tmp.cleanup()

    def hook(self, event, now=NOW, env=None):
        return th.run_hook(io.StringIO(json.dumps(event)), self.env if env is None else env, self.dir, now)

    def context(self, now=NOW, env=None):
        output = self.hook({"hook_event_name": "SessionStart", "source": "startup"}, now, env)
        return json.loads(output)["hookSpecificOutput"]["additionalContext"] if output else ""

    def test_failure_is_remembered_and_injected_at_next_session(self):
        self.hook(failure("WebSearch", WEBSEARCH_400))
        self.hook(failure("WebSearch", WEBSEARCH_400), now=NOW + 60)
        context = self.context(now=NOW + 120)
        self.assertIn("`WebSearch` is not supported by the API provider", context)
        self.assertIn("WebFetch", context)
        self.assertIn("seen 2x", context)

    def test_provider_entries_stay_with_their_provider(self):
        self.hook(failure("WebSearch", WEBSEARCH_400))
        self.hook(failure("Bash", "Exit code 127\n" + GH_MISSING))
        other = self.context(env={})
        self.assertNotIn("WebSearch", other)  # a different provider supports it
        self.assertIn("`gh`", other)  # a missing command is machine-wide

    def test_missing_command_hidden_by_a_pipe_is_recorded(self):
        self.hook(success("Bash", {"command": "gh api repos/x | head -50"}, {"stdout": GH_MISSING, "stderr": ""}))
        self.assertIn("`gh` is not installed", self.context())

    def test_success_clears_the_entry(self):
        self.hook(failure("Bash", GH_MISSING))
        self.hook(success("Bash", {"command": "gh --version"}, {"stdout": "gh version 2.60.0", "stderr": ""}))
        self.hook(failure("WebSearch", WEBSEARCH_400))
        self.hook(success("WebSearch", {"query": "x"}, {"results": []}))
        self.assertEqual(self.context(), "")

    def test_entries_expire(self):
        self.hook(failure("WebSearch", WEBSEARCH_400))
        self.assertNotEqual(self.context(now=NOW + 6 * DAY), "")
        self.assertEqual(self.context(now=NOW + 8 * DAY), "")
        self.assertEqual(th.load_state(self.dir)["entries"], {})

    def test_nothing_is_written_without_findings(self):
        self.hook(failure("WebFetch", USER_REJECTED))
        self.hook(success("WebFetch", {"url": "https://x.dev"}, "page"))
        self.assertFalse((self.dir / th.STATE_FILE).exists())
        self.assertEqual(self.context(), "")

    def test_bad_input_never_raises_from_main(self):
        out = io.StringIO()
        for stdin in ("not json", "[1, 2]", ""):
            with self.subTest(stdin=stdin):
                code = th.main(["hook", "--data-dir", str(self.dir)], io.StringIO(stdin), out, self.env)
                self.assertEqual(code, 0)
        (self.dir / th.STATE_FILE).write_text("{corrupt", encoding="utf-8")
        self.assertEqual(self.context(), "")

    def test_status_and_reset(self):
        self.hook(failure("WebSearch", WEBSEARCH_400))
        self.hook(failure("Bash", GH_MISSING))
        out = io.StringIO()
        th.main(["status", "--data-dir", str(self.dir)], io.StringIO(), out, self.env)
        self.assertIn("tool:WebSearch", out.getvalue())
        self.assertIn("cmd:gh", out.getvalue())
        th.main(["reset", "gh", "--data-dir", str(self.dir)], io.StringIO(), io.StringIO(), self.env)
        self.assertEqual(list(th.load_state(self.dir)["entries"]), ["gateway:gw.example.com|tool:WebSearch"])
        th.main(["reset", "--data-dir", str(self.dir)], io.StringIO(), io.StringIO(), self.env)
        self.assertEqual(th.load_state(self.dir)["entries"], {})


if __name__ == "__main__":
    unittest.main()
