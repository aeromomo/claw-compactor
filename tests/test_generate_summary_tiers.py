"""Tests for generate_summary_tiers.py."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from generate_summary_tiers import generate_tiers, format_human, format_tier_template, _find_memory_files, _classify_section


class TestClassifySection:
    def test_decision(self):
        assert _classify_section("Important Decisions") >= 9

    def test_archive(self):
        assert _classify_section("Archive") <= 2

    def test_action(self):
        assert _classify_section("Action Items") >= 8

    def test_unknown(self):
        assert _classify_section("Random Header") == 5

    def test_case_insensitive(self):
        assert _classify_section("CRITICAL BUGS") >= 9


class TestFindMemoryFiles:
    def test_workspace(self, tmp_workspace):
        files = _find_memory_files(str(tmp_workspace))
        assert len(files) > 0
        assert "MEMORY.md" in str(files[0])

    def test_single_file(self, tmp_workspace):
        assert len(_find_memory_files(str(tmp_workspace / "MEMORY.md"))) == 1

    def test_nonexistent(self):
        with pytest.raises(Exception):
            _find_memory_files("/nonexistent/xyz")

    def test_empty_dir(self, tmp_path):
        assert len(_find_memory_files(str(tmp_path))) == 0


class TestGenerateTiers:
    def test_basic(self, tmp_workspace):
        result = generate_tiers(_find_memory_files(str(tmp_workspace)))
        assert "total_tokens" in result
        assert len(result["tiers"]) == 3

    def test_budgets_respected(self, tmp_workspace):
        result = generate_tiers(_find_memory_files(str(tmp_workspace)))
        for tier in result["tiers"].values():
            assert tier["tokens_used"] <= tier["budget"]

    def test_tier_ordering(self, tmp_workspace):
        result = generate_tiers(_find_memory_files(str(tmp_workspace)))
        counts = [result["tiers"][i]["sections_included"] for i in range(3)]
        assert counts[0] <= counts[1] <= counts[2]

    def test_empty_file(self, empty_file):
        assert generate_tiers([empty_file])["total_tokens"] == 0

    def test_unicode(self, unicode_file):
        assert generate_tiers([unicode_file])["total_tokens"] > 0

    def test_large_file(self, large_file):
        assert generate_tiers([large_file])["total_sections"] > 100

    def test_headers_only(self, headers_only):
        assert isinstance(generate_tiers([headers_only]), dict)

    def test_single_line(self, single_line):
        assert generate_tiers([single_line])["total_sections"] >= 1

    def test_broken_markdown(self, broken_markdown):
        assert isinstance(generate_tiers([broken_markdown]), dict)


class TestFormatHuman:
    def test_output(self, tmp_workspace):
        output = format_human(generate_tiers(_find_memory_files(str(tmp_workspace))))
        assert "Summary Tier Analysis" in output
        for level in range(3):
            assert "Level {}".format(level) in output


class TestFormatTierTemplate:
    def test_markdown(self, tmp_workspace):
        result = generate_tiers(_find_memory_files(str(tmp_workspace)))
        for level in range(3):
            t = format_tier_template(result, level)
            assert "Level {}".format(level) in t
            assert "Budget:" in t

    def test_empty(self, empty_file):
        assert isinstance(format_tier_template(generate_tiers([empty_file]), 0), str)


class TestJsonOutput:
    def test_serializable(self, tmp_workspace):
        result = generate_tiers(_find_memory_files(str(tmp_workspace)))
        assert "tiers" in json.loads(json.dumps(result))
