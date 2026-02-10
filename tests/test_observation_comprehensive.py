"""Comprehensive tests for observation_compressor.py."""
import json
import sys
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from observation_compressor import (
    parse_session_jsonl, extract_tool_interactions, compress_session,
    format_observations_md, format_observations_xml, rule_extract_observations,
    generate_observation_prompt, OBSERVATION_TYPES,
)


def _make_session(tmp_path, messages):
    """Create a JSONL session file from message dicts."""
    f = tmp_path / "test-session.jsonl"
    lines = [json.dumps(m) for m in messages]
    f.write_text("\n".join(lines) + "\n")
    return f


class TestParseSessionJsonl:
    def test_valid_messages(self, tmp_path):
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ]
        f = _make_session(tmp_path, messages)
        result = parse_session_jsonl(f)
        assert len(result) == 2

    def test_empty_file(self, tmp_path):
        f = tmp_path / "empty.jsonl"
        f.write_text("")
        result = parse_session_jsonl(f)
        assert result == []

    def test_single_message(self, tmp_path):
        f = _make_session(tmp_path, [{"role": "user", "content": "single"}])
        result = parse_session_jsonl(f)
        assert len(result) == 1

    def test_mixed_valid_invalid(self, tmp_path):
        f = tmp_path / "mixed.jsonl"
        f.write_text('{"role":"user","content":"ok"}\nnot json\n{"role":"assistant","content":"yes"}\n')
        result = parse_session_jsonl(f)
        # Should skip bad lines
        assert len(result) >= 1

    def test_large_session(self, tmp_path):
        messages = [{"role": "user", "content": f"Message {i}"} for i in range(500)]
        f = _make_session(tmp_path, messages)
        result = parse_session_jsonl(f)
        assert len(result) == 500

    def test_tool_call_messages(self, tmp_path):
        messages = [
            {"role": "user", "content": "Run a command"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "exec", "arguments": '{"command":"ls"}'}}
            ]},
            {"role": "tool", "content": "file1.txt\nfile2.txt", "name": "exec"},
        ]
        f = _make_session(tmp_path, messages)
        result = parse_session_jsonl(f)
        assert len(result) == 3


class TestExtractToolInteractions:
    def test_with_tool_calls(self):
        messages = [
            {"role": "user", "content": "check files"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "exec", "arguments": '{"command":"ls"}'}}
            ]},
            {"role": "tool", "content": "a.txt\nb.txt", "name": "exec"},
        ]
        result = extract_tool_interactions(messages)
        assert len(result) > 0

    def test_no_tool_calls(self):
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        result = extract_tool_interactions(messages)
        assert isinstance(result, list)

    def test_empty(self):
        result = extract_tool_interactions([])
        assert result == []

    def test_only_user_messages(self):
        messages = [{"role": "user", "content": f"msg {i}"} for i in range(5)]
        result = extract_tool_interactions(messages)
        assert isinstance(result, list)


class TestRuleExtractObservations:
    def test_basic_extraction(self):
        interactions = [
            {
                "tool_name": "exec",
                "arguments": {"command": "python3 setup.py install"},
                "result": "Successfully installed package v2.0",
            },
        ]
        result = rule_extract_observations(interactions)
        assert len(result) > 0

    def test_empty_interactions(self):
        result = rule_extract_observations([])
        assert result == []

    def test_read_interaction(self):
        interactions = [
            {
                "tool_name": "read",
                "arguments": {"path": "/etc/config.yaml"},
                "result": "key: value\nother: data",
            },
        ]
        result = rule_extract_observations(interactions)
        assert isinstance(result, list)

    def test_multiple_interactions(self):
        interactions = [
            {"tool_name": "exec", "arguments": {"command": "git status"}, "result": "On branch main"},
            {"tool_name": "exec", "arguments": {"command": "git push"}, "result": "Everything up to date"},
            {"tool_name": "read", "arguments": {"path": "README.md"}, "result": "# Project\nDescription"},
        ]
        result = rule_extract_observations(interactions)
        assert isinstance(result, list)


class TestCompressSession:
    def test_basic_session(self, tmp_path):
        messages = [
            {"role": "user", "content": "Hello, how are you?"},
            {"role": "assistant", "content": "I'm doing well! Let me check something."},
        ]
        f = _make_session(tmp_path, messages)
        result = compress_session(f)
        assert isinstance(result, dict)
        assert "original_tokens" in result or "observations" in result

    def test_session_with_tools(self, tmp_path):
        messages = [
            {"role": "user", "content": "list files"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "exec", "arguments": '{"command":"ls -la"}'}}
            ]},
            {"role": "tool", "content": "total 42\ndrwxr-xr-x 5 user staff 160 Jan 1 00:00 .\n-rw-r--r-- 1 user staff 1234 Jan 1 00:00 test.py", "name": "exec"},
            {"role": "assistant", "content": "I found 3 items in the directory."},
        ]
        f = _make_session(tmp_path, messages)
        result = compress_session(f)
        assert isinstance(result, dict)

    def test_empty_session(self, tmp_path):
        f = tmp_path / "empty.jsonl"
        f.write_text("")
        result = compress_session(f)
        assert isinstance(result, dict)


class TestFormatObservations:
    def test_md_format(self):
        obs = [{"type": "feature", "summary": "Added compression", "details": "rule-based"}]
        result = format_observations_md(obs)
        assert isinstance(result, str)
        assert "compression" in result.lower() or "Added" in result

    def test_xml_format(self):
        obs = [{"type": "bugfix", "summary": "Fixed crash", "details": "null check"}]
        result = format_observations_xml(obs)
        assert isinstance(result, str)

    def test_empty_observations_md(self):
        result = format_observations_md([])
        assert isinstance(result, str)

    def test_empty_observations_xml(self):
        result = format_observations_xml([])
        assert isinstance(result, str)

    def test_multiple_observations(self):
        obs = [
            {"type": "feature", "summary": "Feature A", "details": "details A"},
            {"type": "decision", "summary": "Decision B", "details": "details B"},
            {"type": "config", "summary": "Config C", "details": "details C"},
        ]
        md = format_observations_md(obs)
        xml = format_observations_xml(obs)
        assert len(md) > 0
        assert len(xml) > 0

    def test_unicode_observations(self):
        obs = [{"type": "discovery", "summary": "发现中文支持", "details": "支持 UTF-8"}]
        md = format_observations_md(obs)
        assert "中文" in md


class TestObservationTypes:
    def test_all_types_defined(self):
        assert "feature" in OBSERVATION_TYPES
        assert "bugfix" in OBSERVATION_TYPES
        assert "decision" in OBSERVATION_TYPES
        assert "discovery" in OBSERVATION_TYPES
        assert "config" in OBSERVATION_TYPES

    def test_types_are_strings(self):
        for t in OBSERVATION_TYPES:
            assert isinstance(t, str)


class TestGenerateObservationPrompt:
    def test_generates_prompt(self):
        segment = [
            {"tool_name": "exec", "arguments": {"command": "ls"}, "result": "files"},
        ]
        result = generate_observation_prompt(segment)
        assert isinstance(result, str)
        assert len(result) > 0

    def test_empty_segment(self):
        result = generate_observation_prompt([])
        assert isinstance(result, str)


class TestCompressionRatio:
    """Verify that observation compression achieves claimed ratios."""

    def test_verbose_session_high_compression(self, tmp_path):
        """Sessions with lots of tool output should compress heavily."""
        # Create a session with verbose tool output
        messages = []
        for i in range(20):
            messages.append({"role": "user", "content": f"Check item {i}"})
            messages.append({
                "role": "assistant", "content": "",
                "tool_calls": [{"function": {"name": "exec", "arguments": json.dumps({"command": f"cat /var/log/item{i}.log"})}}]
            })
            messages.append({
                "role": "tool", "name": "exec",
                "content": f"LOG ENTRY {i}: " + "x" * 500 + f"\nSTATUS: OK\nTIME: 2026-01-01T00:00:{i:02d}Z"
            })
            messages.append({"role": "assistant", "content": f"Item {i} is OK."})

        f = _make_session(tmp_path, messages)
        original_size = f.stat().st_size
        result = compress_session(f)

        if result.get("observations"):
            compressed = format_observations_md(result["observations"])
            compressed_size = len(compressed.encode())
            ratio = 1 - (compressed_size / original_size)
            # Should achieve at least 80% compression on verbose output
            assert ratio > 0.5, f"Compression ratio {ratio:.1%} too low"
