"""Tests for the read-only instruction analyzer."""

import tempfile
import unittest
from pathlib import Path
from scripts.audit_context import audit


class AuditContextTests(unittest.TestCase):
    def test_detects_cross_file_duplicate_and_keeps_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sentence = "Always preserve the public API when editing existing code."
            (root / "CLAUDE.md").write_text(sentence + "\n", encoding="utf-8")
            (root / ".claude").mkdir()
            (root / ".claude" / "agent.md").write_text("- " + sentence + "\n", encoding="utf-8")
            before = (root / "CLAUDE.md").read_bytes()
            report = audit(root)
            self.assertEqual(len(report["cross_file_repeated_lines"]), 1)
            self.assertEqual((root / "CLAUDE.md").read_bytes(), before)

    def test_ignores_unrelated_markdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "README.md").write_text("some text", encoding="utf-8")
            self.assertEqual(audit(root)["files"], [])


if __name__ == "__main__":
    unittest.main()
