"""Tests for observation compressor."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from observation_compressor import (
    parse_session_jsonl, extract_tool_interactions,
    generate_observation_prompt, compress_session,
    format_observations_xml, rule_extract_observations,
)


@pytest.fixture
def sample_jsonl(tmp_path):
    """Create a sample .jsonl transcript in OpenClaw format."""
    entries = [
        {"type": "session", "id": "sess1", "timestamp": "2024-01-01T00:00:00Z", "cwd": "/tmp"},
        {"type": "message", "id": "m1", "parentId": "", "timestamp": "2024-01-01T00:00:01Z",
         "message": {"role": "user", "content": "Check the server status"}},
        {"type": "message", "id": "m2", "parentId": "m1", "timestamp": "2024-01-01T00:00:02Z",
         "message": {"role": "assistant", "content": [
             {"type": "text", "text": "I'll check that."},
             {"type": "toolCall", "toolName": "exec", "toolUseId": "tc1",
              "input": {"command": "uptime"}},
         ]}},
        {"type": "message", "id": "m3", "parentId": "m2", "timestamp": "2024-01-01T00:00:03Z",
         "message": {"role": "tool", "content": [
             {"type": "toolResult", "toolUseId": "tc1",
              "result": "up 42 days, load average: 0.5"}
         ]}},
        {"type": "message", "id": "m4", "parentId": "m3", "timestamp": "2024-01-01T00:00:04Z",
         "message": {"role": "assistant", "content": [
             {"type": "text", "text": "Server is up 42 days."},
             {"type": "toolCall", "toolName": "read", "toolUseId": "tc2",
              "input": {"path": "/etc/hostname"}},
         ]}},
        {"type": "message", "id": "m5", "parentId": "m4", "timestamp": "2024-01-01T00:00:05Z",
         "message": {"role": "tool", "content": [
             {"type": "toolResult", "toolUseId": "tc2",
              "result": "gateway-prod"}
         ]}},
    ]
    path = tmp_path / "session.jsonl"
    path.write_text('\n'.join(json.dumps(e) for e in entries))
    return path


@pytest.fixture
def empty_jsonl(tmp_path):
    path = tmp_path / "empty.jsonl"
    path.write_text("")
    return path


class TestParseSessionJsonl:
    def test_basic(self, sample_jsonl):
        messages = parse_session_jsonl(sample_jsonl)
        assert len(messages) >= 3  # session_start + messages
        roles = [m.get("role", m.get("type", "")) for m in messages]
        assert "user" in roles or "session_start" in roles

    def test_empty(self, empty_jsonl):
        messages = parse_session_jsonl(empty_jsonl)
        assert messages == []

    def test_malformed_json(self, tmp_path):
        path = tmp_path / "bad.jsonl"
        path.write_text('not json\n{"type":"message","message":{"role":"user","content":"hi"}}\n{broken')
        messages = parse_session_jsonl(path)
        assert isinstance(messages, list)


class TestExtractToolInteractions:
    def test_basic(self, sample_jsonl):
        messages = parse_session_jsonl(sample_jsonl)
        interactions = extract_tool_interactions(messages)
        assert isinstance(interactions, list)

    def test_empty(self):
        interactions = extract_tool_interactions([])
        assert interactions == []


class TestGenerateObservationPrompt:
    def test_returns_string(self):
        segment = [{"tool_name": "exec", "input_summary": "uptime", "output_summary": "42 days"}]
        prompt = generate_observation_prompt(segment)
        assert isinstance(prompt, str)
        assert len(prompt) > 0


class TestRuleExtractObservations:
    def test_with_interactions(self):
        interactions = [
            {"tool_name": "exec", "input_summary": '{"command": "uptime"}',
             "output_summary": "up 42 days", "output_size": 20, "assistant_text": "checking"},
        ]
        observations = rule_extract_observations(interactions)
        assert isinstance(observations, list)

    def test_empty(self):
        observations = rule_extract_observations([])
        assert isinstance(observations, list)


class TestFormatObservationsXml:
    def test_basic(self):
        observations = [
            {"type": "discovery", "title": "Server status",
             "facts": ["Server up 42 days"], "narrative": "Checked server."}
        ]
        xml = format_observations_xml(observations)
        assert "<observation>" in xml
        assert "discovery" in xml


class TestCompressSession:
    def test_basic(self, sample_jsonl):
        result = compress_session(sample_jsonl)
        assert isinstance(result, dict)

    def test_empty(self, empty_jsonl):
        result = compress_session(empty_jsonl)
        assert isinstance(result, dict)
