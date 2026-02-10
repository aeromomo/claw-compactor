"""Tests for the benchmark command output."""
import argparse
import json
import sys
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from mem_compress import cmd_benchmark


class TestBenchmarkOutput:
    """Test benchmark report format and content."""

    def _make_workspace(self, tmp_path):
        (tmp_path / "MEMORY.md").write_text(
            "# Memory\n\n## Important Decisions\n"
            "- Decided to use Python 3.11 for all scripts\n"
            "- Decided to use pytest for testing framework\n"
            "- Decided to use tiktoken for token estimation\n\n"
            "## Configuration Notes\n"
            "| Setting | Value | Description |\n"
            "|---------|-------|-------------|\n"
            "| timeout | 30s | Request timeout |\n"
            "| retries | 3 | Max retries |\n"
            "| workers | 8 | Parallel workers |\n\n"
            "## Daily Log\n"
            "- 2026-01-01: Set up project\n"
            "- 2026-01-02: Added compression\n"
            "- 2026-01-03: Added dedup\n"
        )
        (tmp_path / "TOOLS.md").write_text(
            "# Tools Reference\n\n"
            "| Tool | Path | Notes |\n"
            "|------|------|-------|\n"
            "| python3 | /usr/bin/python3 | Main interpreter |\n"
            "| node | /usr/bin/node | JavaScript runtime |\n"
        )
        mem = tmp_path / "memory"
        mem.mkdir()
        (mem / "2026-01-01.md").write_text("# January 1\n- Started project setup\n- Installed dependencies\n")
        return tmp_path

    def test_benchmark_has_header(self, tmp_path, capsys):
        ws = self._make_workspace(tmp_path)
        args = argparse.Namespace(json=False)
        cmd_benchmark(ws, args)
        out = capsys.readouterr().out
        assert "claw-compactor Performance Report" in out

    def test_benchmark_has_all_steps(self, tmp_path, capsys):
        ws = self._make_workspace(tmp_path)
        args = argparse.Namespace(json=False)
        cmd_benchmark(ws, args)
        out = capsys.readouterr().out
        assert "Rule Engine" in out
        assert "Dictionary Compress" in out
        assert "RLE Patterns" in out
        assert "Tokenizer Optimize" in out
        assert "TOTAL (memory)" in out

    def test_benchmark_has_savings_headline(self, tmp_path, capsys):
        ws = self._make_workspace(tmp_path)
        args = argparse.Namespace(json=False)
        cmd_benchmark(ws, args)
        out = capsys.readouterr().out
        assert "Total savings:" in out
        assert "💰" in out

    def test_benchmark_has_session_info(self, tmp_path, capsys):
        ws = self._make_workspace(tmp_path)
        args = argparse.Namespace(json=False)
        cmd_benchmark(ws, args)
        out = capsys.readouterr().out
        assert "Session Transcripts:" in out

    def test_benchmark_has_recommendations(self, tmp_path, capsys):
        ws = self._make_workspace(tmp_path)
        args = argparse.Namespace(json=False)
        cmd_benchmark(ws, args)
        out = capsys.readouterr().out
        assert "Recommendations:" in out

    def test_benchmark_json_structure(self, tmp_path, capsys):
        ws = self._make_workspace(tmp_path)
        args = argparse.Namespace(json=True)
        cmd_benchmark(ws, args)
        data = json.loads(capsys.readouterr().out)
        assert "steps" in data
        assert len(data["steps"]) == 4
        assert "total_before" in data
        assert "total_after" in data
        assert "total_saved" in data
        assert "total_pct" in data
        assert data["total_before"] >= data["total_after"]

    def test_benchmark_step_names(self, tmp_path, capsys):
        ws = self._make_workspace(tmp_path)
        args = argparse.Namespace(json=True)
        cmd_benchmark(ws, args)
        data = json.loads(capsys.readouterr().out)
        names = [s["name"] for s in data["steps"]]
        assert names == ["Rule Engine", "Dictionary Compress", "RLE Patterns", "Tokenizer Optimize"]

    def test_benchmark_saved_non_negative(self, tmp_path, capsys):
        ws = self._make_workspace(tmp_path)
        args = argparse.Namespace(json=True)
        cmd_benchmark(ws, args)
        data = json.loads(capsys.readouterr().out)
        assert data["total_saved"] >= 0

    def test_benchmark_empty_workspace(self, tmp_path):
        args = argparse.Namespace(json=False)
        result = cmd_benchmark(tmp_path, args)
        assert result == 1  # No files found

    def test_benchmark_date_in_output(self, tmp_path, capsys):
        ws = self._make_workspace(tmp_path)
        args = argparse.Namespace(json=False)
        cmd_benchmark(ws, args)
        out = capsys.readouterr().out
        assert "Date:" in out
