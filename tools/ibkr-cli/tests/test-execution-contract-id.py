"""Tests for patches/execution-contract-id.patch: con_id on `orders executions` rows.

Every identifier here is fake: placeholder accounts, contract ids, execution ids and order ids.
No real account, order or position belongs in this public repo.
"""

import unittest
from contextlib import nullcontext
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch

from ibkr_cli import ib_service
from ibkr_cli.config import ProfileConfig

ACCOUNT = "U00000001"
OTHER_ACCOUNT = "U00000002"


def fill(account, con_id, *, exec_id, order_id=2, perm_id=100000001, sec_type="STK"):
    return SimpleNamespace(
        contract=SimpleNamespace(
            conId=con_id,
            symbol="AAPL" if sec_type == "STK" else "UKT",
            localSymbol="AAPL" if sec_type == "STK" else "UKT 0 1/8 01/31/28",
            secType=sec_type,
            exchange="SMART",
            currency="USD" if sec_type == "STK" else "GBP",
        ),
        execution=SimpleNamespace(
            acctNumber=account,
            execId=exec_id,
            orderId=order_id,
            permId=perm_id,
            clientId=7,
            exchange="NASDAQ",
            side="SLD",
            shares=1.0,
            price=100.0,
            cumQty=1.0,
            avgPrice=100.0,
        ),
        commissionReport=SimpleNamespace(commission=1.0, currency="USD", realizedPNL=0.0),
        time=datetime(2026, 1, 2, 15, 30, tzinfo=UTC),
    )


class FakeIB:
    def __init__(self, fills):
        self._fills = fills

    def managedAccounts(self):
        return [ACCOUNT, OTHER_ACCOUNT]

    def reqExecutions(self):
        return self._fills


class ExecutionContractIdTest(unittest.TestCase):
    profile = ProfileConfig(host="127.0.0.1", port=4005, client_id=12, mode="live")

    def executions(self, fills, account=None):
        with patch.object(ib_service, "ib_session", return_value=nullcontext(FakeIB(fills))):
            return ib_service.get_executions(self.profile, account=account)

    def test_every_row_carries_its_contract_id(self):
        payload = self.executions(
            [
                fill(ACCOUNT, 900000001, exec_id="0000e1.01"),
                fill(OTHER_ACCOUNT, 900000002, exec_id="0000e2.01", sec_type="BOND"),
            ]
        )
        by_exec = {row["exec_id"]: row for row in payload["rows"]}
        self.assertEqual(by_exec["0000e1.01"]["con_id"], 900000001)
        self.assertEqual(by_exec["0000e2.01"]["con_id"], 900000002)

    def test_perm_id_and_order_id_are_kept(self):
        # Order ids repeat across client sessions; perm_id is the broker-wide order key, and
        # this patch must not disturb either field.
        (row,) = self.executions(
            [fill(ACCOUNT, 900000001, exec_id="0000e1.01", order_id=2, perm_id=100000009)]
        )["rows"]
        self.assertEqual(row["order_id"], 2)
        self.assertEqual(row["perm_id"], 100000009)

    def test_unset_contract_id_is_null_not_zero(self):
        payloads = [
            self.executions([fill(ACCOUNT, value, exec_id="0000e1.01")])["rows"][0]["con_id"]
            for value in (0, None, -5, True, "not-a-number")
        ]
        self.assertEqual(payloads, [None] * 5)

    def test_account_filter_still_applies(self):
        payload = self.executions(
            [
                fill(ACCOUNT, 900000001, exec_id="0000e1.01"),
                fill(OTHER_ACCOUNT, 900000002, exec_id="0000e2.01"),
            ],
            account=ACCOUNT,
        )
        self.assertEqual([row["con_id"] for row in payload["rows"]], [900000001])


if __name__ == "__main__":
    unittest.main()
