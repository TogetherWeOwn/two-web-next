"""Shared PR-text and tracked-file internal reference patterns."""
import re

DEFAULT_PREFIXES = "TOG|PAP|PAPA"
INSTANCE_UI = (
    re.compile(r"(?:^|[\s(<\[])/[A-Z]{2,6}/(?:issues|agents|projects|approvals|runs)/"),
    "an instance UI link",
)


def ticket_id_pattern(prefixes=DEFAULT_PREFIXES, slug=False):
    if slug:
        # Unicode alphanumeric boundaries, with underscores as slug separators.
        return re.compile(rf"(?<![^\W_])(?:{prefixes})-\d+(?![^\W_])", re.I)
    return re.compile(rf"\b(?:{prefixes})-\d+\b")


def file_reference_count(text, prefixes=DEFAULT_PREFIXES):
    """Count raw file content, including comments; PR prose strips comments separately."""
    return sum(1 for _ in ticket_id_pattern(prefixes).finditer(text)) + sum(
        1 for _ in INSTANCE_UI[0].finditer(text)
    )
