"""Tests for compress_memory.py."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from compress_memory import rule_compress, generate_llm_prompt, compress_file, _collect_files


class TestRuleCompress:
    def test_removes_duplicate_lines(self):
        result = rule_compress("# Title\n\n- item one\n- item one\n- item two\n")
        assert result.count("item one") == 1
        assert "item two" in result

    def test_strips_redundant_blanks(self):
        result = rule_compress("# Title\n\n\n\n\n\nContent\n\n\n\nMore")
        assert "\n\n\n" not in result

    def test_empty(self):
        assert rule_compress("") == ""

    def test_preserves_headers(self):
        result = rule_compress("# Title\n\n## Section\n\nContent")
        assert "# Title" in result
        assert "## Section" in result

    def test_unicode(self):
        result = rule_compress("# 笔记\n\n- 你好世界\n- 你好世界\n- 独特内容\n")
        assert result.count("你好世界") == 1

    def test_large_input(self):
        text = "# Large\n" + "".join("- Entry {}: content\n".format(i) for i in range(5000))
        result = rule_compress(text)
        assert len(result) <= len(text)

    def test_broken_markdown(self):
        assert isinstance(rule_compress("##NoSpace\n- \n```\nunclosed\n"), str)

    def test_single_line(self):
        assert rule_compress("Just one line.") == "Just one line."


class TestGenerateLlmPrompt:
    def test_contains_content(self):
        prompt = generate_llm_prompt("some text")
        assert "some text" in prompt

    def test_target_pct(self):
        assert "30%" in generate_llm_prompt("text", target_pct=30)

    def test_empty(self):
        assert isinstance(generate_llm_prompt(""), str)


class TestCompressFile:
    def test_dry_run(self, tmp_workspace):
        mem = tmp_workspace / "MEMORY.md"
        original = mem.read_text()
        result = compress_file(mem, dry_run=True)
        assert result["dry_run"] is True
        assert mem.read_text() == original

    def test_writes_output(self, tmp_path):
        f = tmp_path / "test.md"
        f.write_text("# Title\n\n- item\n- item\n- item\n\n\n\n")
        result = compress_file(f, dry_run=False)
        assert "written_to" in result
        assert f.read_text().count("item") == 1

    def test_output_file(self, tmp_path):
        f = tmp_path / "src.md"
        f.write_text("# Test\n\nContent\n")
        out = tmp_path / "out.md"
        compress_file(f, output=str(out))
        assert out.exists()

    def test_no_llm(self, tmp_path):
        f = tmp_path / "t.md"
        f.write_text("# Test\n\n" + "- Entry\n" * 100)
        assert "llm_prompt" not in compress_file(f, dry_run=True, no_llm=True)

    def test_stats(self, tmp_workspace):
        result = compress_file(tmp_workspace / "MEMORY.md", dry_run=True)
        assert result["original_tokens"] >= result["rule_compressed_tokens"]

    def test_empty_file(self, empty_file):
        assert compress_file(empty_file, dry_run=True)["original_tokens"] == 0

    def test_unicode(self, unicode_file):
        assert compress_file(unicode_file, dry_run=True)["original_tokens"] > 0


class TestCollectFiles:
    def test_directory(self, tmp_workspace):
        assert len(_collect_files(str(tmp_workspace))) > 0

    def test_single_file(self, tmp_workspace):
        assert len(_collect_files(str(tmp_workspace / "MEMORY.md"))) == 1

    def test_nonexistent(self):
        with pytest.raises(Exception):
            _collect_files("/nonexistent/xyz")

    def test_older_than(self, tmp_workspace):
        assert len(_collect_files(str(tmp_workspace), older_than=1)) == 0
        assert len(_collect_files(str(tmp_workspace), older_than=0)) > 0
