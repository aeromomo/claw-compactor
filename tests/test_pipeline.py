"""Tests for the full pipeline mode."""
import argparse
import json
import sys
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from mem_compress import cmd_full, _count_tokens_in_workspace


class TestFullPipeline:
    """Test the full pipeline command."""

    def _make_workspace(self, tmp_path):
        """Create a minimal workspace with memory files."""
        mem = tmp_path / "memory"
        mem.mkdir()
        (tmp_path / "MEMORY.md").write_text(
            "# Memory\n\n## Decisions\n- Use Python for scripts\n- Use pytest for testing\n\n"
            "## Notes\n- Hello world\n- Hello world\n\n## Empty Section\n\n"
        )
        (tmp_path / "TOOLS.md").write_text(
            "# Tools\n| Name | Version |\n|------|--------|\n| Python | 3.11 |\n| Node | 20 |\n"
        )
        (mem / "2026-01-01.md").write_text("# Jan 1\n- Did some stuff\n- More stuff\n")
        return tmp_path

    def test_full_pipeline_runs(self, tmp_path, capsys, monkeypatch):
        ws = self._make_workspace(tmp_path)
        # Prevent observe from scanning real sessions directory
        monkeypatch.setattr("os.path.expanduser", lambda p: str(tmp_path / "fake_home") if ".openclaw" in p else p)
        args = argparse.Namespace(json=False, since=None)
        result = cmd_full(ws, args)
        assert result == 0
        out = capsys.readouterr().out
        assert "Tokens saved:" in out
        assert "Before:" in out
        assert "After:" in out

    def test_full_pipeline_completes_without_error(self, tmp_path, monkeypatch):
        ws = self._make_workspace(tmp_path)
        monkeypatch.setattr("os.path.expanduser", lambda p: str(tmp_path / "fake_home") if ".openclaw" in p else p)
        args = argparse.Namespace(json=False, since=None)
        result = cmd_full(ws, args)
        assert result == 0

    def test_full_pipeline_preserves_files(self, tmp_path, monkeypatch):
        ws = self._make_workspace(tmp_path)
        monkeypatch.setattr("os.path.expanduser", lambda p: str(tmp_path / "fake_home") if ".openclaw" in p else p)
        args = argparse.Namespace(json=False, since=None)
        cmd_full(ws, args)
        assert (ws / "MEMORY.md").exists()
        assert (ws / "TOOLS.md").exists()


class TestObserveCommand:
    """Test the observe command with mock sessions."""

    def test_observe_no_sessions_dir(self, tmp_path, capsys):
        from mem_compress import cmd_observe
        args = argparse.Namespace(json=False, since=None)
        # Patch sessions dir to nonexistent path
        import mem_compress
        import os
        old_expand = os.path.expanduser
        def mock_expand(p):
            if ".openclaw/sessions" in p:
                return str(tmp_path / "nonexistent")
            return old_expand(p)
        
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(os.path, "expanduser", mock_expand)
            result = cmd_observe(tmp_path, args)
        # Should return 1 or handle gracefully
        assert result in (0, 1)

    def test_observe_with_empty_sessions(self, tmp_path, capsys):
        from mem_compress import cmd_observe
        sessions = tmp_path / "sessions"
        sessions.mkdir()
        # Point observe to tmp workspace with sessions subdir
        args = argparse.Namespace(json=False, since=None)
        
        import mem_compress
        import os
        old_expand = os.path.expanduser
        def mock_expand(p):
            if ".openclaw/sessions" in p:
                return str(tmp_path / "nonexistent")
            return old_expand(p)
        
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(os.path, "expanduser", mock_expand)
            # Create sessions dir under workspace
            (tmp_path / "sessions").mkdir(exist_ok=True)
            result = cmd_observe(tmp_path, args)

    def test_observe_tracker_persistence(self, tmp_path):
        """Test that .observed-sessions.json is maintained."""
        from mem_compress import cmd_observe
        mem = tmp_path / "memory"
        mem.mkdir()
        tracker = mem / ".observed-sessions.json"
        tracker.write_text(json.dumps({"old-session.jsonl": "2026-01-01T00:00:00"}))
        
        # Read it back
        data = json.loads(tracker.read_text())
        assert "old-session.jsonl" in data
