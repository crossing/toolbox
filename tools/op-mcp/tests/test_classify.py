"""Classification is default-deny: only allowlisted shapes are reads."""

import sys
import unittest

from op_mcp.classify import is_read, matches, positionals
from op_mcp.config import DEFAULT_READ_ALLOWLISTS

GWS = DEFAULT_READ_ALLOWLISTS["gws"]
FREEAGENT = DEFAULT_READ_ALLOWLISTS["freeagent"]


class TestDefaultDeny(unittest.TestCase):
    def test_empty_argv_is_a_write(self):
        self.assertFalse(is_read([], GWS))

    def test_unknown_command_is_a_write(self):
        self.assertFalse(is_read(["frobnicate"], GWS))

    def test_misspelled_read_is_a_write(self):
        self.assertFalse(is_read(["gmail", "users", "messages", "lst"], GWS))

    def test_empty_allowlist_denies_everything(self):
        self.assertFalse(is_read(["gmail", "users", "messages", "list"], []))

    def test_empty_pattern_matches_nothing(self):
        # A degenerate empty pattern must not act as a universal allow.
        self.assertFalse(is_read(["anything"], [[]]))
        self.assertFalse(matches([], ["anything"]))

    def test_prefix_of_a_read_shape_is_a_write(self):
        # The full shape is required; a bare parent command stays denied.
        self.assertFalse(is_read(["gmail", "users", "messages"], GWS))


class TestGwsDefaults(unittest.TestCase):
    def test_gmail_reads(self):
        self.assertTrue(is_read(["gmail", "users", "messages", "list"], GWS))
        self.assertTrue(is_read(["gmail", "users", "messages", "get"], GWS))
        self.assertTrue(is_read(["gmail", "users", "messages", "attachments", "get"], GWS))
        self.assertTrue(is_read(["gmail", "users", "threads", "list"], GWS))

    def test_gmail_writes(self):
        self.assertFalse(is_read(["gmail", "users", "messages", "send"], GWS))
        self.assertFalse(is_read(["gmail", "users", "messages", "trash"], GWS))
        self.assertFalse(is_read(["gmail", "users", "drafts", "create"], GWS))

    def test_drive(self):
        self.assertTrue(is_read(["drive", "files", "list"], GWS))
        self.assertTrue(is_read(["drive", "files", "download"], GWS))
        self.assertFalse(is_read(["drive", "files", "delete"], GWS))
        self.assertFalse(is_read(["drive", "files", "create"], GWS))

    def test_calendar(self):
        self.assertTrue(is_read(["calendar", "events", "list"], GWS))
        self.assertFalse(is_read(["calendar", "events", "insert"], GWS))


class TestFreeagentDefaults(unittest.TestCase):
    def test_list_and_get_are_reads(self):
        self.assertTrue(is_read(["bills", "list"], FREEAGENT))
        self.assertTrue(is_read(["transactions", "list", "--human"], FREEAGENT))
        self.assertTrue(is_read(["expenses", "get", "12345"], FREEAGENT))

    def test_report_commands_are_reads(self):
        self.assertTrue(is_read(["balance-sheet"], FREEAGENT))
        self.assertTrue(is_read(["balance-sheet", "--as-at", "2026-08-21"], FREEAGENT))
        self.assertTrue(is_read(["profit-and-loss", "--accounting-period", "2025/26"], FREEAGENT))
        self.assertTrue(is_read(["trial-balance", "--to", "2026-08-21"], FREEAGENT))

    def test_mutating_verbs_are_writes(self):
        self.assertFalse(is_read(["bills", "create"], FREEAGENT))
        self.assertFalse(is_read(["explanations", "approve", "12345"], FREEAGENT))
        self.assertFalse(is_read(["explanations", "delete", "12345"], FREEAGENT))
        self.assertFalse(is_read(["bills", "attach", "12345"], FREEAGENT))


class TestFlags(unittest.TestCase):
    def test_flags_are_ignored_for_matching(self):
        self.assertEqual(
            positionals(["--human", "bills", "list", "--params", ""]),
            ["bills", "list", ""],
        )
        self.assertTrue(
            is_read(["gmail", "users", "messages", "list", "--params", "{}"], GWS)
        )

    def test_flag_value_inside_pattern_window_fails_closed(self):
        # A separate flag value displacing the subcommand shape must classify as
        # a write (default deny), never accidentally as a read.
        self.assertFalse(
            is_read(["--profile", "x", "gmail", "users", "messages", "list"], GWS)
        )

    def test_trailing_positionals_after_full_match_are_arguments(self):
        self.assertTrue(is_read(["expenses", "get", "12345", "extra"], FREEAGENT))


if __name__ == "__main__":
    sys.exit(unittest.main())
