"""Tests for patches/fx-contracts.patch: --sec-type CASH (a currency pair on IDEALPRO).

GBP.USD's conId and contract details are public reference data; the accounts are
placeholders. No Gateway is contacted: every IBKR call goes to a fake.
"""

import unittest
from contextlib import nullcontext
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from ib_async import Contract, Stock
from typer.testing import CliRunner

from ibkr_cli import app as app_module
from ibkr_cli import ib_service
from ibkr_cli.config import ProfileConfig

GBPUSD_CON_ID = 12087797
ACCOUNT = "U00000001"
PROFILE = ProfileConfig(host="127.0.0.1", port=4005, client_id=12, mode="live")


class _Event:
    def __init__(self):
        self.handlers = []

    def connect(self, handler):
        self.handlers.append(handler)

    def disconnect(self, handler):
        self.handlers.remove(handler)


def fx(con_id=GBPUSD_CON_ID, symbol="GBP", currency="USD", sec_type="CASH", valid_exchanges="IDEALPRO"):
    """Contract details shaped like IBKR's live answer for GBP.USD (probe of 2026-09-29)."""
    return SimpleNamespace(
        contract=Contract(
            secType=sec_type, conId=con_id, symbol=symbol, currency=currency,
            exchange="IDEALPRO", localSymbol=f"{symbol}.{currency}",
        ),
        descAppend="",
        longName="British pound",
        validExchanges=valid_exchanges,
        secIdList=[],
        minTick=5e-05,
        minSize=0.01,
        sizeIncrement=0.01,
    )


class FakeIB:
    def __init__(self, details=(), bars=()):
        self.details = list(details)
        self.bars = list(bars)
        self.qualify_requests = []
        self.detail_requests = []
        self.what_if = []
        self.placed = []
        self.bar_requests = []
        self.errorEvent = _Event()

    def managedAccounts(self):
        return [ACCOUNT]

    def qualifyContracts(self, contract):
        self.qualify_requests.append(contract)
        return [None]

    def reqContractDetails(self, contract):
        self.detail_requests.append(contract)
        return self.details

    def whatIfOrder(self, contract, order):
        self.what_if.append((contract, order))
        return SimpleNamespace(
            status="PreSubmitted",
            initMarginBefore="0", initMarginChange="0", initMarginAfter="0",
            maintMarginBefore="0", maintMarginChange="0", maintMarginAfter="0",
            equityWithLoanBefore="10", equityWithLoanChange="0", equityWithLoanAfter="10",
            commission=2.0, minCommission=None, maxCommission=None,
            commissionCurrency="USD", warningText="",
        )

    def reqHistoricalData(self, contract, **kwargs):
        self.bar_requests.append((contract, kwargs))
        return self.bars


def preview(ib, **kwargs):
    base = dict(
        action="BUY", symbol="GBP.USD", quantity=1000, exchange="SMART", currency="USD",
        order_type="LMT", limit_price=1.345, account=ACCOUNT, sec_type="CASH",
    )
    base.update(kwargs)
    with patch.object(ib_service, "ib_session", return_value=nullcontext(ib)):
        return ib_service.preview_stock_order(PROFILE, **base)


class NormalizeFxTest(unittest.TestCase):
    def test_pair_is_split_and_exchange_pinned(self):
        self.assertEqual(ib_service.normalize_fx_request("gbp.usd", "SMART", "USD"), ("GBP", "USD", "IDEALPRO"))
        self.assertEqual(ib_service.normalize_fx_request("EUR.GBP", "IDEALPRO", ""), ("EUR", "GBP", "IDEALPRO"))

    def test_currency_must_match_the_quote(self):
        with self.assertRaisesRegex(ValueError, "does not match the quote currency of EUR.GBP"):
            ib_service.normalize_fx_request("EUR.GBP", "SMART", "USD")

    def test_other_exchanges_are_refused(self):
        with self.assertRaisesRegex(ValueError, "only on IDEALPRO"):
            ib_service.normalize_fx_request("GBP.USD", "IDEAL", "USD")

    def test_non_pair_without_conid_is_refused(self):
        for label in ("GBP", "GBPUSD", "GBP.GBP", "GB.USD"):
            with self.assertRaises(ValueError, msg=label):
                ib_service.normalize_fx_request(label, "SMART", "USD")

    def test_conid_alone_names_the_pair(self):
        self.assertEqual(
            ib_service.normalize_fx_request("cable", "SMART", "USD", GBPUSD_CON_ID), (None, "USD", "IDEALPRO")
        )

    def test_isin_is_refused_for_cash(self):
        with self.assertRaisesRegex(ValueError, "not --isin"):
            ib_service.normalize_contract_request("CASH", None, "US0378331005")

    def test_cash_needs_no_identifier(self):
        self.assertEqual(ib_service.normalize_contract_request("cash"), ("CASH", None, None))


class BuildContractTest(unittest.TestCase):
    def test_pair_builds_a_cash_contract_on_idealpro(self):
        contract = ib_service._build_contract("GBP.USD", "SMART", "USD", sec_type="CASH")
        self.assertEqual(
            (contract.secType, contract.symbol, contract.currency, contract.exchange, contract.conId),
            ("CASH", "GBP", "USD", "IDEALPRO", 0),
        )

    def test_conid_is_carried(self):
        contract = ib_service._build_contract("GBP.USD", "SMART", "USD", sec_type="CASH", con_id=GBPUSD_CON_ID)
        self.assertEqual((contract.conId, contract.symbol), (GBPUSD_CON_ID, "GBP"))

    def test_stock_is_unchanged(self):
        contract = ib_service._build_contract("intc", "SMART", "USD")
        self.assertIsInstance(contract, Stock)
        self.assertEqual((contract.symbol, contract.exchange), ("INTC", "SMART"))


class QualifyFxTest(unittest.TestCase):
    def qualify(self, ib, symbol="GBP.USD", exchange="SMART", currency="USD", **kwargs):
        return ib_service._qualify_contract(ib, symbol, exchange, currency, sec_type="CASH", **kwargs)

    def test_resolves_one_cash_contract(self):
        ib = FakeIB(details=[fx()])
        contract, instrument = self.qualify(ib, con_id=GBPUSD_CON_ID)
        self.assertEqual((contract.conId, contract.exchange), (GBPUSD_CON_ID, "IDEALPRO"))
        self.assertEqual(instrument["pair"], "GBP.USD")
        self.assertEqual((instrument["min_tick"], instrument["min_size"], instrument["size_increment"]),
                         (5e-05, 0.01, 0.01))
        self.assertEqual(ib.qualify_requests, [])
        requested = ib.detail_requests[0]
        self.assertEqual((requested.secType, requested.symbol, requested.currency, requested.exchange),
                         ("CASH", "GBP", "USD", "IDEALPRO"))

    def test_conid_mismatch_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "resolved conId"):
            self.qualify(FakeIB(details=[fx(con_id=1)]), con_id=GBPUSD_CON_ID)

    def test_ambiguous_match_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "Ambiguous contract"):
            self.qualify(FakeIB(details=[fx(), fx(con_id=2)]))

    def test_non_cash_answer_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "resolved a STK contract"):
            self.qualify(FakeIB(details=[fx(sec_type="STK")]))

    def test_unknown_pair_is_a_clear_error(self):
        with self.assertRaisesRegex(RuntimeError, "Unable to qualify contract for CASH pair GBP.USD"):
            self.qualify(FakeIB())

    def test_pair_mismatch_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "resolved EUR.USD, not the requested"):
            self.qualify(FakeIB(details=[fx(symbol="EUR")]))

    def test_conid_only_checks_the_quote_currency(self):
        with self.assertRaisesRegex(RuntimeError, "quote currency is not USD"):
            self.qualify(FakeIB(details=[fx(symbol="EUR", currency="GBP")]), symbol="x", con_id=GBPUSD_CON_ID)


class PreviewTest(unittest.TestCase):
    def test_buy_gbp_with_usd(self):
        ib = FakeIB(details=[fx()])
        payload = preview(ib, con_id=GBPUSD_CON_ID)
        contract, order = ib.what_if[0]
        self.assertEqual((contract.secType, contract.conId, contract.exchange), ("CASH", GBPUSD_CON_ID, "IDEALPRO"))
        self.assertEqual((order.action, order.orderType, order.lmtPrice, order.totalQuantity, order.account),
                         ("BUY", "LMT", 1.345, 1000, ACCOUNT))
        self.assertEqual((payload["sec_type"], payload["con_id"], payload["pair"]), ("CASH", GBPUSD_CON_ID, "GBP.USD"))
        self.assertEqual((payload["symbol"], payload["currency"], payload["exchange"]), ("GBP", "USD", "IDEALPRO"))

    def test_bad_pair_fails_before_opening_a_session(self):
        with patch.object(ib_service, "ib_session") as session:
            with self.assertRaisesRegex(ValueError, "named by currency pair"):
                ib_service.preview_stock_order(
                    PROFILE, action="BUY", symbol="USDGBP", quantity=1000, order_type="LMT",
                    limit_price=0.75, sec_type="CASH",
                )
        session.assert_not_called()


class BarsTest(unittest.TestCase):
    def bars(self, ib, **kwargs):
        with patch.object(ib_service, "ib_session", return_value=nullcontext(ib)):
            return ib_service.get_historical_bars(PROFILE, symbol="GBP.USD", sec_type="CASH", **kwargs)

    def test_cash_defaults_to_midpoint(self):
        bar = SimpleNamespace(
            date=datetime(2026, 9, 29, 12, 55, tzinfo=timezone.utc),
            open=1.3421, high=1.3425, low=1.342, close=1.34235, volume=-1, average=-1, barCount=-1,
        )
        ib = FakeIB(details=[fx()], bars=[bar])
        payload = self.bars(ib)
        self.assertEqual(ib.bar_requests[0][1]["whatToShow"], "MIDPOINT")
        self.assertEqual(ib.bar_requests[0][0].exchange, "IDEALPRO")
        self.assertEqual(payload["what_to_show"], "MIDPOINT")
        self.assertEqual((payload["pair"], payload["min_tick"]), ("GBP.USD", 5e-05))
        self.assertEqual(payload["rows"][0]["close"], 1.34235)
        self.assertEqual(payload["rows"][0]["date"], "2026-09-29T12:55:00+00:00")

    def test_trades_is_refused_for_cash(self):
        with patch.object(ib_service, "ib_session") as session:
            with self.assertRaisesRegex(ValueError, "no TRADES history"):
                ib_service.get_historical_bars(PROFILE, symbol="GBP.USD", sec_type="CASH", what_to_show="TRADES")
        session.assert_not_called()

    def test_stock_default_stays_trades(self):
        self.assertEqual(ib_service.resolve_what_to_show("STK", None), "TRADES")
        self.assertEqual(ib_service.resolve_what_to_show(None, "midpoint"), "MIDPOINT")
        self.assertEqual(ib_service.resolve_what_to_show("CASH", "bid"), "BID")


class CliTest(unittest.TestCase):
    def setUp(self):
        resolved = (SimpleNamespace(default_profile="paper"), True, "paper", PROFILE)
        for name, value in (("resolve_profile_or_exit", resolved), ("check_for_update", None)):
            patcher = patch.object(app_module, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.printed = []
        patcher = patch.object(app_module, "print_json", side_effect=self.printed.append)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.runner = CliRunner()

    def test_buy_and_bars_pass_cash_through(self):
        with patch.object(app_module, "preview_stock_order", return_value={}) as preview_fn:
            result = self.runner.invoke(
                app_module.app,
                ["buy", "GBP.USD", "1000", "--sec-type", "CASH", "--conid", str(GBPUSD_CON_ID),
                 "--exchange", "IDEALPRO", "--type", "LMT", "--limit", "1.345", "--preview", "--json"],
            )
        self.assertEqual(result.exit_code, 0, result.output)
        kwargs = preview_fn.call_args.kwargs
        self.assertEqual((kwargs["sec_type"], kwargs["con_id"], kwargs["symbol"]), ("CASH", GBPUSD_CON_ID, "GBP.USD"))

        with patch.object(app_module, "get_historical_bars", return_value={}) as bars_fn:
            result = self.runner.invoke(app_module.app, ["bars", "GBP.USD", "--sec-type", "CASH", "--json"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIsNone(bars_fn.call_args.kwargs["what_to_show"])
        self.assertEqual(bars_fn.call_args.kwargs["sec_type"], "CASH")


if __name__ == "__main__":
    unittest.main()
