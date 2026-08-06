#!/usr/bin/env python3

import importlib.util
import os
import secrets
import sys
import unittest
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


TOOL_DIR = Path(os.environ.get("TOOL_SRC") or Path(__file__).resolve().parent.parent)
MODULE_PATH = TOOL_DIR / "flex-fetch.py"
SPEC = importlib.util.spec_from_file_location("ibkr_flex_fetch", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load Flex helper module")
flex_fetch = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = flex_fetch
SPEC.loader.exec_module(flex_fetch)


def flex_statement_xml(account, *, trade_date="20260102", amount="10.00"):
    return f"""<FlexStatement accountId="{account}" fromDate="2026-01-01" toDate="2026-01-31">
      <Trades>
        <Trade accountId="{account}" tradeDate="{trade_date}" symbol="SYNTH" description="Synthetic instrument" assetCategory="STK" buySell="BUY" quantity="2" tradePrice="5" proceeds="-10" ibCommission="-0.25" netCash="-10.25" fifoPnlRealized="0" currency="GBP" />
      </Trades>
      <CashTransactions>
        <CashTransaction accountId="{account}" reportDate="{trade_date}" symbol="SYNTH" description="Synthetic dividend" type="Dividends" amount="{amount}" currency="GBP" />
      </CashTransactions>
      <StmtFunds>
        <StatementOfFundsLine accountId="{account}" reportDate="{trade_date}" activityCode="DEP" amount="{amount}" currency="GBP" description="Synthetic deposit" />
      </StmtFunds>
    </FlexStatement>"""


def statement_xml(*accounts, trade_date="20260102", amount="10.00"):
    statements = "\n".join(
        flex_statement_xml(account, trade_date=trade_date, amount=amount)
        for account in accounts
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Synthetic" type="AF">
  <FlexStatements count="{len(accounts)}">
    {statements}
  </FlexStatements>
</FlexQueryResponse>
"""


class SplitDateRangeTests(unittest.TestCase):
    def test_keeps_365_inclusive_days_in_one_chunk(self):
        self.assertEqual(
            flex_fetch.split_date_range(date(2024, 1, 1), date(2024, 12, 30)),
            [(date(2024, 1, 1), date(2024, 12, 30))],
        )

    def test_starts_a_second_chunk_on_day_366(self):
        self.assertEqual(
            flex_fetch.split_date_range(date(2024, 1, 1), date(2024, 12, 31)),
            [
                (date(2024, 1, 1), date(2024, 12, 30)),
                (date(2024, 12, 31), date(2024, 12, 31)),
            ],
        )

    def test_preserves_the_requested_historical_endpoint(self):
        chunks = flex_fetch.split_date_range(date(2022, 6, 1), date(2026, 5, 5))
        self.assertEqual(chunks[-1][1], date(2026, 5, 5))
        self.assertTrue(all((end - start).days + 1 <= 365 for start, end in chunks))

    def test_rejects_an_inverted_range(self):
        with self.assertRaisesRegex(flex_fetch.FlexError, "start date must not be after end date"):
            flex_fetch.split_date_range(date(2026, 5, 6), date(2026, 5, 5))


class StatementParsingTests(unittest.TestCase):
    def test_trade_rows_retain_the_statement_account(self):
        rows = flex_fetch.parse_statement(
            statement_xml("ACCOUNT_SYNTH_A"), "trades", "ACCOUNT_SYNTH_A"
        )
        self.assertEqual(rows[0]["account"], "ACCOUNT_SYNTH_A")
        self.assertEqual(rows[0]["trade_date"], "2026-01-02")
        self.assertEqual(rows[0]["symbol"], "SYNTH")

    def test_transfer_and_dividend_rows_retain_the_statement_account(self):
        transfer = flex_fetch.parse_statement(
            statement_xml("ACCOUNT_SYNTH_A"), "transfers", "ACCOUNT_SYNTH_A"
        )[0]
        dividend = flex_fetch.parse_statement(
            statement_xml("ACCOUNT_SYNTH_A"), "dividends", "ACCOUNT_SYNTH_A"
        )[0]
        self.assertEqual(transfer["account"], "ACCOUNT_SYNTH_A")
        self.assertEqual(transfer["type"], "DEPOSIT")
        self.assertEqual(dividend["account"], "ACCOUNT_SYNTH_A")
        self.assertEqual(dividend["type"], "Dividends")

    def test_filters_a_multi_account_query_to_the_requested_account(self):
        rows = flex_fetch.parse_statement(
            statement_xml("ACCOUNT_SYNTH_A", "ACCOUNT_SYNTH_B"),
            "trades",
            "ACCOUNT_SYNTH_A",
        )
        self.assertEqual([row["account"] for row in rows], ["ACCOUNT_SYNTH_A"])

    def test_returns_all_configured_query_accounts_when_no_filter_is_requested(self):
        rows = flex_fetch.parse_statement(
            statement_xml("ACCOUNT_SYNTH_A", "ACCOUNT_SYNTH_B"),
            "trades",
            None,
        )
        self.assertEqual(
            sorted(row["account"] for row in rows),
            ["ACCOUNT_SYNTH_A", "ACCOUNT_SYNTH_B"],
        )

    def test_rejects_an_account_absent_from_the_query(self):
        with self.assertRaisesRegex(flex_fetch.FlexError, "requested account is not present"):
            flex_fetch.parse_statement(
                statement_xml("ACCOUNT_SYNTH_B"), "trades", "ACCOUNT_SYNTH_A"
            )

    def test_rejects_a_statement_without_account_identity(self):
        xml = statement_xml("ACCOUNT_SYNTH_A").replace(
            ' accountId="ACCOUNT_SYNTH_A"', ""
        )
        with self.assertRaisesRegex(flex_fetch.FlexError, "does not identify an account"):
            flex_fetch.parse_statement(xml, "trades", "ACCOUNT_SYNTH_A")


class FetchHistoryTests(unittest.TestCase):
    def test_merges_non_overlapping_chunks_newest_first(self):
        calls = []
        pauses = []

        def request(_token, query_id, start, end):
            calls.append((query_id, start, end))
            return statement_xml(
                "ACCOUNT_SYNTH_A",
                trade_date=end.strftime("%Y%m%d"),
            )

        result = flex_fetch.fetch_history(
            object(),
            "QUERY_SYNTH_A",
            "trades",
            "ACCOUNT_SYNTH_A",
            date(2024, 1, 1),
            date(2024, 12, 31),
            request,
            pause=pauses.append,
        )

        self.assertEqual(
            calls,
            [
                ("QUERY_SYNTH_A", date(2024, 1, 1), date(2024, 12, 30)),
                ("QUERY_SYNTH_A", date(2024, 12, 31), date(2024, 12, 31)),
            ],
        )
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["rows"][0]["trade_date"], "2024-12-31")
        self.assertEqual(result["from_date"], "2024-01-01")
        self.assertEqual(result["to_date"], "2024-12-31")
        self.assertEqual(result["chunks"], 2)
        self.assertEqual(pauses, [6])


class FetchRawTests(unittest.TestCase):
    def test_returns_unparsed_xml_chunks_with_their_ranges(self):
        calls = []
        pauses = []

        def request(_token, query_id, start, end):
            calls.append((query_id, start, end))
            return statement_xml("ACCOUNT_SYNTH_A", trade_date=end.strftime("%Y%m%d"))

        result = flex_fetch.fetch_raw(
            object(),
            "QUERY_SYNTH_A",
            date(2024, 1, 1),
            date(2024, 12, 31),
            request,
            pause=pauses.append,
        )

        self.assertEqual(
            calls,
            [
                ("QUERY_SYNTH_A", date(2024, 1, 1), date(2024, 12, 30)),
                ("QUERY_SYNTH_A", date(2024, 12, 31), date(2024, 12, 31)),
            ],
        )
        self.assertEqual(result["chunk_count"], 2)
        self.assertEqual(result["from_date"], "2024-01-01")
        self.assertEqual(result["to_date"], "2024-12-31")
        first, second = result["chunks"]
        self.assertEqual(first["from"], "2024-01-01")
        self.assertEqual(first["to"], "2024-12-30")
        self.assertIn("<FlexQueryResponse", first["xml"])
        self.assertIn('tradeDate="20241230"', first["xml"])
        self.assertEqual(second["from"], "2024-12-31")
        self.assertEqual(second["to"], "2024-12-31")
        self.assertEqual(pauses, [6])

    def test_rejects_invalid_xml_instead_of_passing_it_through(self):
        with self.assertRaisesRegex(flex_fetch.FlexError, "invalid Flex XML"):
            flex_fetch.fetch_raw(
                object(),
                "QUERY_SYNTH_A",
                date(2026, 1, 1),
                date(2026, 1, 31),
                lambda *_args: "not xml at all",
            )

    def test_rejects_a_statement_without_account_identity(self):
        xml = statement_xml("ACCOUNT_SYNTH_A").replace(
            ' accountId="ACCOUNT_SYNTH_A"', ""
        )
        with self.assertRaisesRegex(flex_fetch.FlexError, "does not identify an account"):
            flex_fetch.fetch_raw(
                object(),
                "QUERY_SYNTH_A",
                date(2026, 1, 1),
                date(2026, 1, 31),
                lambda *_args: xml,
            )


class RequestStatementTests(unittest.TestCase):
    def test_uses_exact_from_and_to_overrides(self):
        runtime_secret = secrets.token_urlsafe(24)
        urls = []
        responses = iter(
            [
                "<FlexStatementResponse><Status>Success</Status><ReferenceCode>12345</ReferenceCode></FlexStatementResponse>",
                statement_xml("ACCOUNT_SYNTH_A"),
            ]
        )
        original_http_get = flex_fetch._http_get

        def fake_http_get(url):
            urls.append(url)
            return next(responses)

        flex_fetch._http_get = fake_http_get
        try:
            result = flex_fetch.request_statement(
                runtime_secret,
                "100001",
                date(2025, 4, 6),
                date(2026, 4, 5),
            )
        finally:
            flex_fetch._http_get = original_http_get

        self.assertIn("<FlexQueryResponse", result)
        request_query = parse_qs(urlsplit(urls[0]).query)
        self.assertEqual(request_query["fd"], ["20250406"])
        self.assertEqual(request_query["td"], ["20260405"])
        self.assertEqual(request_query["q"], ["100001"])
        self.assertEqual(request_query["t"], [runtime_secret])

    def test_network_failure_does_not_echo_runtime_secret(self):
        runtime_secret = secrets.token_urlsafe(24)
        original_http_get = flex_fetch._http_get

        def failing_http_get(_url):
            raise RuntimeError(runtime_secret)

        flex_fetch._http_get = failing_http_get
        try:
            with self.assertRaises(flex_fetch.FlexError) as error:
                flex_fetch.request_statement(
                    runtime_secret,
                    "100001",
                    date(2026, 1, 1),
                    date(2026, 1, 31),
                )
        finally:
            flex_fetch._http_get = original_http_get

        self.assertNotIn(runtime_secret, str(error.exception))
        self.assertEqual(str(error.exception), "unable to contact the IBKR Flex service")


if __name__ == "__main__":
    unittest.main()
