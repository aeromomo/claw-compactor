"""Tests for audit_memory.py."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from audit_memory import audit_file, audit_workspace, format_report


@pytest.fixture
def audit_workspace_dir(tmp_path):
    """Create a workspace with various memory files."""
    (tmp_path / "MEMORY.md").write_text(
        "# Memory\n\n## 项目\n\n| Key | Value |\n|-----|-------|\n| A | 1 |\n\n## Empty\n"
    )
    (tmp_path / "TOOLS.md").write_text("# Tools\n\n- SSH key: xyz\n- 🔧 Config done\n")
    mem = tmp_path / "memory"
    mem.mkdir()
    (mem / "2026-01-01.md").write_text("# Old note\n\nSome content here.\n")
    (mem / "2026-02-09.md").write_text("# Today\n\nFresh content.\n")
    return tmp_path


class TestAuditFile:
    def test_basic(self, audit_workspace_dir):
        r = audit_file(audit_workspace_dir / "MEMORY.md")
        assert r["tokens"] > 0
        assert r["name"] == "MEMORY.md"
        assert isinstance(r["suggestions"], list)

    def test_table_suggestion(self, audit_workspace_dir):
        r = audit_file(audit_workspace_dir / "MEMORY.md")
        assert any("Table" in s for s in r["suggestions"])

    def test_emoji_suggestion(self, audit_workspace_dir):
        r = audit_file(audit_workspace_dir / "TOOLS.md")
        assert any("emoji" in s for s in r["suggestions"])

    def test_stale(self, tmp_path):
        import os, time
        f = tmp_path / "old.md"
        f.write_text("# Old\n\nStuff\n")
        # Set mtime to 30 days ago
        old_time = time.time() - 30 * 86400
        os.utime(f, (old_time, old_time))
        r = audit_file(f, stale_days=14)
        assert r["is_stale"] is True


class TestAuditWorkspace:
    def test_basic(self, audit_workspace_dir):
        r = audit_workspace(str(audit_workspace_dir))
        assert r["total_files"] >= 2
        assert r["total_tokens"] > 0
        assert "age_distribution" in r

    def test_nonexistent(self):
        with pytest.raises(Exception):
            audit_workspace("/nonexistent/path/xyz")

    def test_format(self, audit_workspace_dir):
        r = audit_workspace(str(audit_workspace_dir))
        text = format_report(r)
        assert "Memory Audit Report" in text
        assert "Suggestions" in text
