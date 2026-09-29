"""Tests for patches/bond-contracts.patch: --sec-type, --conid and --isin.

Every identifier here is fake or public: the ISINs are published security identifiers and
the accounts are placeholders. No real account or position belongs in this public repo.
"""

import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch

from ib_async import Contract, Stock
from typer.testing import CliRunner

from ibkr_cli import app as app_module
from ibkr_cli import ib_service
from ibkr_cli.config import ProfileConfig

# 0 1/8% Treasury Gilt 2028 (TN28, per the DMO auction prospectus) and Apple Inc: public
# ISINs with valid check digits.
GILT_ISIN = "GB00BMBL1G81"
OTHER_GILT_ISIN = "GB00BMBL1F74"  # 0 5/8% Treasury Gilt 2050
STOCK_ISIN = "US0378331005"
GILT_CON_ID = 900000001  # fake
ACCOUNT = "U00000001"


class _Event:
    def __init__(self):
        self.handlers = []

    def connect(self, handler):
        self.handlers.append(handler)

    def disconnect(self, handler):
        self.handlers.remove(handler)


def gilt(con_id=GILT_CON_ID, sec_type="BOND", isin=GILT_ISIN, valid_exchanges="SMART"):
    """Contract details shaped like IBKR's live answer for a gilt.

    IBKR returns a bond contract with no symbol, local symbol or currency; the description
    and the ISIN in secIdList are the only readable identification.
    """
    return SimpleNamespace(
        contract=Contract(secType=sec_type, conId=con_id, exchange="SMART", tradingClass="UKT"),
        descAppend="UKT 0 1/8 01/31/28",
        longName="",
        validExchanges=valid_exchanges,
        secIdList=[SimpleNamespace(tag="ISIN", value=isin)],
    )


class FakeIB:
    """Records what the service asks IBKR to qualify and to preview."""

    def __init__(self, resolved=None, details=()):
        self.resolved = resolved
        self.details = list(details)
        self.qualify_requests = []
        self.detail_requests = []
        self.what_if = []
        self.bar_requests = []
        self.errorEvent = _Event()

    def managedAccounts(self):
        return [ACCOUNT, "U00000002"]

    def qualifyContracts(self, contract):
        self.qualify_requests.append(contract)
        # ib_async signals an unknown or ambiguous contract with [None], not [].
        return [self.resolved]

    def reqContractDetails(self, contract):
        self.detail_requests.append(contract)
        return self.details

    def whatIfOrder(self, contract, order):
        self.what_if.append((contract, order))
        return SimpleNamespace(
            status="PreSubmitted",
            initMarginBefore="0",
            initMarginChange="1",
            initMarginAfter="1",
            maintMarginBefore="0",
            maintMarginChange="1",
            maintMarginAfter="1",
            equityWithLoanBefore="10",
            equityWithLoanChange="-1",
            equityWithLoanAfter="9",
            commission=3.0,
            minCommission=None,
            maxCommission=None,
            commissionCurrency="GBP",
            warningText="",
        )

    def reqHistoricalData(self, contract, **kwargs):
        self.bar_requests.append((contract, kwargs))
        return []


PROFILE = ProfileConfig(host="127.0.0.1", port=4005, client_id=12, mode="live")


def preview(ib, **kwargs):
    base = dict(
        action="BUY",
        symbol="UKT",
        quantity=100,
        exchange="SMART",
        currency="GBP",
        order_type="LMT",
        limit_price=90.0,
        account=ACCOUNT,
    )
    base.update(kwargs)
    with patch.object(ib_service, "ib_session", return_value=nullcontext(ib)):
        return ib_service.preview_stock_order(PROFILE, **base)


class NormalizeContractRequestTest(unittest.TestCase):
    def test_default_is_stock_by_ticker(self):
        self.assertEqual(ib_service.normalize_contract_request(), ("STK", None, None))

    def test_sec_type_and_isin_are_normalised(self):
        self.assertEqual(
            ib_service.normalize_contract_request("bond", None, " gb00bmbl1g81 "),
            ("BOND", None, GILT_ISIN),
        )

    def test_unsupported_sec_type_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unsupported security type 'OPT'"):
            ib_service.normalize_contract_request("OPT")

    def test_bond_requires_an_identifier(self):
        with self.assertRaisesRegex(ValueError, "BOND contracts must be identified with --conid or --isin"):
            ib_service.normalize_contract_request("BOND")

    def test_isin_check_digit_is_enforced(self):
        with self.assertRaisesRegex(ValueError, "not a valid ISIN"):
            ib_service.normalize_contract_request("BOND", None, "GB00BMBL1G82")
        with self.assertRaisesRegex(ValueError, "not a valid ISIN"):
            ib_service.normalize_contract_request("BOND", None, "GB00BMBL1G8")

    def test_conid_must_be_positive(self):
        with self.assertRaisesRegex(ValueError, "--conid must be a positive integer"):
            ib_service.normalize_contract_request("BOND", 0)


class BuildContractTest(unittest.TestCase):
    def test_stock_by_ticker_is_unchanged(self):
        contract = ib_service._build_contract("intc", "SMART", "USD")
        self.assertIsInstance(contract, Stock)
        self.assertEqual((contract.symbol, contract.exchange, contract.currency), ("INTC", "SMART", "USD"))
        self.assertEqual(contract.secIdType, "")
        self.assertEqual(contract.conId, 0)

    def test_bond_by_isin_uses_sec_id_and_ignores_the_label(self):
        contract = ib_service._build_contract("UKT", "SMART", "GBP", sec_type="BOND", isin=GILT_ISIN)
        self.assertEqual(contract.secType, "BOND")
        self.assertEqual((contract.secIdType, contract.secId), ("ISIN", GILT_ISIN))
        self.assertEqual(contract.symbol, "")
        # IBKR matches no ISIN once any exchange is named, so none is sent.
        self.assertEqual((contract.exchange, contract.currency), ("", "GBP"))

    def test_bond_by_conid(self):
        contract = ib_service._build_contract("UKT", "SMART", "GBP", sec_type="BOND", con_id=GILT_CON_ID)
        self.assertEqual((contract.secType, contract.conId, contract.symbol), ("BOND", GILT_CON_ID, ""))
        self.assertEqual((contract.secIdType, contract.exchange), ("", "SMART"))

    def test_stock_by_isin(self):
        contract = ib_service._build_contract("AAPL", "SMART", "USD", isin=STOCK_ISIN)
        self.assertEqual((contract.secType, contract.secIdType, contract.secId), ("STK", "ISIN", STOCK_ISIN))


class QualifyContractTest(unittest.TestCase):
    def qualify(self, ib, **kwargs):
        base = dict(sec_type="BOND", isin=GILT_ISIN)
        base.update(kwargs)
        return ib_service._qualify_contract(ib, "UKT", base.pop("exchange", "SMART"), "GBP", **base)

    def test_bond_resolves_with_description_and_isin(self):
        ib = FakeIB(details=[gilt()])
        contract, instrument = self.qualify(ib)
        self.assertEqual((contract.conId, contract.exchange), (GILT_CON_ID, "SMART"))
        self.assertEqual(
            instrument,
            {"description": "UKT 0 1/8 01/31/28", "isin": GILT_ISIN, "valid_exchanges": ["SMART"]},
        )
        self.assertEqual(ib.qualify_requests, [])

    def test_unknown_contract_is_a_clear_error_not_a_none_crash(self):
        with self.assertRaisesRegex(RuntimeError, f"Unable to qualify contract for BOND ISIN {GILT_ISIN}"):
            self.qualify(FakeIB())

    def test_unknown_stock_keeps_the_symbol_message(self):
        with self.assertRaisesRegex(RuntimeError, "Unable to qualify contract for symbol 'UKT'"):
            ib_service._qualify_contract(FakeIB(None), "UKT", "SMART", "GBP")

    def test_ambiguous_match_is_refused(self):
        ib = FakeIB(details=[gilt(), gilt(con_id=GILT_CON_ID + 1)])
        with self.assertRaisesRegex(RuntimeError, "Ambiguous contract .* Pass --conid"):
            self.qualify(ib)

    def test_conid_mismatch_is_refused(self):
        ib = FakeIB(details=[gilt(con_id=GILT_CON_ID + 1)])
        with self.assertRaisesRegex(RuntimeError, "resolved conId"):
            self.qualify(ib, isin=None, con_id=GILT_CON_ID)

    def test_isin_mismatch_is_refused(self):
        ib = FakeIB(details=[gilt(isin=OTHER_GILT_ISIN)])
        with self.assertRaisesRegex(RuntimeError, f"resolved ISIN {OTHER_GILT_ISIN}"):
            self.qualify(ib)

    def test_sec_type_mismatch_is_refused(self):
        ib = FakeIB(details=[gilt(sec_type="STK")])
        with self.assertRaisesRegex(RuntimeError, "resolved a STK contract"):
            self.qualify(ib)

    def test_exchange_must_be_valid_for_the_bond(self):
        ib = FakeIB(details=[gilt()])
        with self.assertRaisesRegex(RuntimeError, "Exchange 'LSE' is not valid"):
            self.qualify(ib, exchange="LSE")


class PreviewTest(unittest.TestCase):
    def test_bond_preview_by_isin(self):
        ib = FakeIB(details=[gilt()])
        payload = preview(ib, sec_type="BOND", isin=GILT_ISIN)

        requested = ib.detail_requests[0]
        self.assertEqual((requested.secType, requested.secIdType, requested.secId), ("BOND", "ISIN", GILT_ISIN))
        contract, order = ib.what_if[0]
        self.assertEqual((contract.conId, contract.exchange), (GILT_CON_ID, "SMART"))
        self.assertEqual((order.action, order.orderType, order.lmtPrice, order.account), ("BUY", "LMT", 90.0, ACCOUNT))
        self.assertTrue(payload["preview_only"])
        self.assertEqual(payload["sec_type"], "BOND")
        self.assertEqual(payload["con_id"], GILT_CON_ID)
        self.assertEqual(payload["description"], "UKT 0 1/8 01/31/28")
        self.assertEqual(payload["isin"], GILT_ISIN)
        self.assertEqual(payload["commission"], 3.0)

    def test_stock_preview_still_resolves_by_ticker(self):
        resolved = Stock(symbol="INTC", exchange="SMART", currency="USD")
        resolved.conId = 270639
        ib = FakeIB(resolved)
        payload = preview(ib, symbol="intc", currency="USD", limit_price=20.0)

        requested = ib.qualify_requests[0]
        self.assertIsInstance(requested, Stock)
        self.assertEqual((requested.symbol, requested.secIdType), ("INTC", ""))
        self.assertEqual((payload["sec_type"], payload["con_id"]), ("STK", 270639))
        # A ticker-resolved stock payload gains no new keys.
        self.assertNotIn("description", payload)
        self.assertNotIn("isin", payload)

    def test_bond_without_identifier_fails_before_opening_a_session(self):
        with patch.object(ib_service, "ib_session") as session:
            with self.assertRaisesRegex(ValueError, "must be identified"):
                ib_service.preview_stock_order(
                    PROFILE, action="BUY", symbol="UKT", quantity=100, currency="GBP",
                    order_type="LMT", limit_price=90.0, sec_type="BOND",
                )
        session.assert_not_called()

    def test_unknown_bond_raises_instead_of_crashing(self):
        with self.assertRaisesRegex(RuntimeError, "Unable to qualify contract"):
            preview(FakeIB(), sec_type="BOND", isin=GILT_ISIN)


class BarsTest(unittest.TestCase):
    def test_bond_bars_by_conid(self):
        ib = FakeIB(details=[gilt()])
        with patch.object(ib_service, "ib_session", return_value=nullcontext(ib)):
            payload = ib_service.get_historical_bars(
                PROFILE, symbol="UKT", currency="GBP", what_to_show="MIDPOINT",
                sec_type="BOND", con_id=GILT_CON_ID,
            )
        requested = ib.detail_requests[0]
        self.assertEqual((requested.secType, requested.conId), ("BOND", GILT_CON_ID))
        self.assertEqual(ib.bar_requests[0][0].conId, GILT_CON_ID)
        self.assertEqual((payload["sec_type"], payload["con_id"], payload["count"]), ("BOND", GILT_CON_ID, 0))
        self.assertEqual(payload["description"], "UKT 0 1/8 01/31/28")


class CliTest(unittest.TestCase):
    def setUp(self):
        resolved = (SimpleNamespace(default_profile="paper"), True, "paper", PROFILE)
        for name, value in (
            ("resolve_profile_or_exit", resolved),
            ("check_for_update", None),  # no network from a unit test
        ):
            patcher = patch.object(app_module, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # The module-level rich console writes to the real stdout, not CliRunner's, so
        # capture the JSON payloads where they are emitted.
        self.printed = []
        patcher = patch.object(app_module, "print_json", side_effect=self.printed.append)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.runner = CliRunner()

    def test_buy_preview_passes_the_selector_through(self):
        with patch.object(app_module, "preview_stock_order", return_value={"preview_only": True}) as preview_fn:
            result = self.runner.invoke(
                app_module.app,
                ["buy", "UKT", "100", "--currency", "GBP", "--sec-type", "BOND", "--isin", GILT_ISIN,
                 "--type", "LMT", "--limit", "90", "--account", ACCOUNT, "--preview", "--json"],
            )
        self.assertEqual(result.exit_code, 0, result.output)
        kwargs = preview_fn.call_args.kwargs
        self.assertEqual((kwargs["sec_type"], kwargs["isin"], kwargs["con_id"]), ("BOND", GILT_ISIN, None))
        self.assertEqual(self.printed[-1], {"profile": "paper", "preview_only": True})

    def test_sell_and_bars_accept_conid(self):
        with patch.object(app_module, "preview_stock_order", return_value={}) as preview_fn:
            result = self.runner.invoke(
                app_module.app,
                ["sell", "UKT", "100", "--sec-type", "BOND", "--conid", str(GILT_CON_ID),
                 "--type", "LMT", "--limit", "90", "--preview", "--json"],
            )
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(preview_fn.call_args.kwargs["con_id"], GILT_CON_ID)

        with patch.object(app_module, "get_historical_bars", return_value={}) as bars_fn:
            result = self.runner.invoke(
                app_module.app,
                ["bars", "UKT", "--sec-type", "BOND", "--conid", str(GILT_CON_ID), "--json"],
            )
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual((bars_fn.call_args.kwargs["sec_type"], bars_fn.call_args.kwargs["con_id"]), ("BOND", GILT_CON_ID))

    def test_defaults_stay_stock(self):
        with patch.object(app_module, "preview_stock_order", return_value={}) as preview_fn:
            result = self.runner.invoke(
                app_module.app, ["buy", "INTC", "1", "--type", "LMT", "--limit", "20", "--preview", "--json"]
            )
        self.assertEqual(result.exit_code, 0, result.output)
        kwargs = preview_fn.call_args.kwargs
        self.assertEqual((kwargs["sec_type"], kwargs["con_id"], kwargs["isin"]), ("STK", None, None))

    def test_invalid_selector_is_a_structured_error(self):
        result = self.runner.invoke(
            app_module.app,
            ["buy", "UKT", "100", "--sec-type", "BOND", "--type", "LMT", "--limit", "90", "--preview", "--json"],
        )
        self.assertNotEqual(result.exit_code, 0)
        error = self.printed[-1]["error"]
        self.assertEqual(error["code"], app_module.ERROR_ORDER_OPERATION_FAILED)
        self.assertIn("must be identified with --conid or --isin", error["message"])
        self.assertEqual(error["details"]["sec_type"], "BOND")


if __name__ == "__main__":
    unittest.main()
