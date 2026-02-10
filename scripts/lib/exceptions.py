"""Custom exceptions for claw-compactor.

Part of claw-compactor. License: MIT.
"""


class MemCompressError(Exception):
    """Base exception for claw-compactor operations."""
    pass


class FileNotFoundError_(MemCompressError):
    """Raised when a required file or directory is not found."""
    pass


class ParseError(MemCompressError):
    """Raised when input cannot be parsed (malformed markdown, JSON, etc.)."""
    pass


class TokenEstimationError(MemCompressError):
    """Raised when token estimation fails."""
    pass
