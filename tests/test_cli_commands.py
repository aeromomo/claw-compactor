"""CLI tests — every subcommand via subprocess, covering exit codes and output."""
import json
import subprocess
import sys
import pytest
from pathlib import Path

SCRIPT = str(Path(__file__).resolve().parent.parent / "scripts" / "mem_compress.py")
PYTHON = sys.executable


def run_cmd(workspace, command, *extra, timeout=30):
    """Run mem_compress.py and return (exit_code, stdout, stderr)."""
    args = [PYTHON, SCRIPT, str(workspace), command] + list(extra)
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return result.returncode, result.stdout, result.stderr


@pytest.fixture
def workspace(tmp_path):
    """Create a realistic test workspace."""
    (tmp_path / "MEMORY.md").write_text(
        "# Memory\n\n## Decisions\n- Use Python 3.11\n- Use pytest\n- Use tiktoken\n\n"
        "## Notes\n- Server IP: 192.168.1.100\n- Server IP: 192.168.1.100\n"
        "- Backup runs at 3am\n\n"
        "## Empty Section\n\n"
    )
    (tmp_path / "TOOLS.md").write_text(
        "# Tools\n\n| Tool | Version | Path |\n|------|---------|------|\n"
        "| Python | 3.11 | /usr/bin/python3 |\n| Node | 20 | /usr/bin/node |\n"
        "| Docker | 24.0 | /usr/bin/docker |\n"
    )
    (tmp_path / "AGENTS.md").write_text(
        "# Agents\n\nThis is the agents file.\n\n## Rules\n- Be helpful\n- Be concise\n"
    )
    mem = tmp_path / "memory"
    mem.mkdir()
    (mem / "2026-01-01.md").write_text("# Jan 1\n- Set up project\n- Installed deps\n")
    (mem / "2026-01-02.md").write_text("# Jan 2\n- Added compression\n- Fixed bug #42\n")
    return tmp_path


class TestEstimateCLI:
    def test_exit_code_0(self, workspace):
        code, out, err = run_cmd(workspace, "estimate")
        assert code == 0

    def test_json_output(self, workspace):
        code, out, err = run_cmd(workspace, "estimate", "--json")
        assert code == 0
        data = json.loads(out)
        assert "files" in data

    def test_threshold(self, workspace):
        code, out, err = run_cmd(workspace, "estimate", "--threshold", "99999")
        assert code == 0

    def test_nonexistent_workspace(self, tmp_path):
        code, out, err = run_cmd(tmp_path / "nope", "estimate")
        assert code != 0


class TestCompressCLI:
    def test_exit_code_0(self, workspace):
        code, out, err = run_cmd(workspace, "compress")
        assert code == 0
        assert "token" in out.lower() or "compress" in out.lower()

    def test_dry_run(self, workspace):
        original = (workspace / "MEMORY.md").read_text()
        code, out, err = run_cmd(workspace, "compress", "--dry-run")
        assert code == 0
        assert (workspace / "MEMORY.md").read_text() == original

    def test_json(self, workspace):
        code, out, err = run_cmd(workspace, "compress", "--json")
        assert code == 0
        data = json.loads(out)
        assert isinstance(data, list)

    def test_shows_saved(self, workspace):
        code, out, err = run_cmd(workspace, "compress")
        assert code == 0
        assert "saved" in out.lower()


class TestDedupCLI:
    def test_exit_code_0(self, workspace):
        code, out, err = run_cmd(workspace, "dedup")
        assert code == 0

    def test_json(self, workspace):
        code, out, err = run_cmd(workspace, "dedup", "--json")
        assert code == 0
        data = json.loads(out)
        assert isinstance(data, dict)


class TestTiersCLI:
    def test_exit_code_0(self, workspace):
        code, out, err = run_cmd(workspace, "tiers")
        assert code == 0

    def test_json(self, workspace):
        code, out, err = run_cmd(workspace, "tiers", "--json")
        assert code == 0
        data = json.loads(out)
        assert isinstance(data, dict)

    def test_shows_levels(self, workspace):
        code, out, err = run_cmd(workspace, "tiers")
        assert "Level 0" in out or "level" in out.lower()


class TestAuditCLI:
    def test_exit_code_0(self, workspace):
        code, out, err = run_cmd(workspace, "audit")
        assert code == 0

    def test_json(self, workspace):
        code, out, err = run_cmd(workspace, "audit", "--json")
        assert code == 0
        data = json.loads(out)
        assert isinstance(data, dict)

    def test_stale_days(self, workspace):
        code, out, err = run_cmd(workspace, "audit", "--stale-days", "1")
        assert code == 0


class TestDictCLI:
    def test_exit_code_0(self, workspace):
        code, out, err = run_cmd(workspace, "dict")
        assert code == 0

    def test_json(self, workspace):
        code, out, err = run_cmd(workspace, "dict", "--json")
        assert code == 0
        data = json.loads(out)
        assert isinstance(data, dict)

    def test_creates_codebook(self, workspace):
        run_cmd(workspace, "dict")
        assert (workspace / "memory" / ".codebook.json").exists()


class TestOptimizeCLI:
    def test_exit_code_0(self, workspace):
        code, out, err = run_cmd(workspace, "optimize")
        assert code == 0
        assert "token" in out.lower() or "optimiz" in out.lower()

    def test_dry_run(self, workspace):
        original = (workspace / "MEMORY.md").read_text()
        code, out, err = run_cmd(workspace, "optimize", "--dry-run")
        assert code == 0
        assert (workspace / "MEMORY.md").read_text() == original

    def test_json(self, workspace):
        code, out, err = run_cmd(workspace, "optimize", "--json")
        assert code == 0
        data = json.loads(out)
        assert "before" in data and "after" in data


class TestBenchmarkCLI:
    def test_exit_code_0(self, workspace):
        code, out, err = run_cmd(workspace, "benchmark")
        assert code == 0

    def test_has_report_header(self, workspace):
        code, out, err = run_cmd(workspace, "benchmark")
        assert "Performance Report" in out

    def test_has_savings_headline(self, workspace):
        code, out, err = run_cmd(workspace, "benchmark")
        assert "Total savings:" in out

    def test_has_steps(self, workspace):
        code, out, err = run_cmd(workspace, "benchmark")
        assert "Rule Engine" in out
        assert "TOTAL" in out

    def test_json(self, workspace):
        code, out, err = run_cmd(workspace, "benchmark", "--json")
        assert code == 0
        data = json.loads(out)
        assert data["total_saved"] >= 0

    def test_empty_workspace(self, tmp_path):
        code, out, err = run_cmd(tmp_path, "benchmark")
        assert code == 1  # No files


class TestObserveCLI:
    def test_no_sessions(self, workspace):
        code, out, err = run_cmd(workspace, "observe")
        # Should handle missing sessions dir
        assert code in (0, 1)

    def test_since_filter(self, workspace):
        code, out, err = run_cmd(workspace, "observe", "--since", "2099-01-01")
        assert code in (0, 1)


class TestInvalidInputs:
    def test_unknown_command(self, workspace):
        result = subprocess.run(
            [PYTHON, SCRIPT, str(workspace), "bogus"],
            capture_output=True, text=True
        )
        assert result.returncode != 0

    def test_missing_workspace(self):
        result = subprocess.run(
            [PYTHON, SCRIPT], capture_output=True, text=True
        )
        assert result.returncode != 0

    def test_missing_command(self, workspace):
        result = subprocess.run(
            [PYTHON, SCRIPT, str(workspace)], capture_output=True, text=True
        )
        assert result.returncode != 0

    def test_verbose_flag(self, workspace):
        code, out, err = run_cmd(workspace, "estimate", "-v")
        assert code == 0
