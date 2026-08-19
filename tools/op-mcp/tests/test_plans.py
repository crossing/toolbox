"""Plan store lifecycle: planned -> rejected | executed, and TTL expiry."""

import os
import stat
import sys
import tempfile
import unittest

from op_mcp.plans import (
    STATUS_EXECUTED,
    STATUS_EXPIRED,
    STATUS_PLANNED,
    STATUS_REJECTED,
    PlanError,
    PlanStore,
    Step,
)

DAY = 86400


class PlanStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = [1_700_000_000.0]
        self.store = PlanStore(
            os.path.join(self.tmp.name, "plans"), ttl_days=7, clock=lambda: self.now[0]
        )
        self.step = Step(toolset="freeagent", argv=["bills", "create", "--contact", "x"])

    def create(self, **kwargs):
        defaults = dict(
            name="Invoice Example Corp for July",
            steps=[self.step],
            area="accounting",
            rationale="testing",
            agent="/fake/agents/example-agent",
        )
        defaults.update(kwargs)
        return self.store.create(**defaults)

    def test_create_and_get_roundtrip(self):
        plan = self.create()
        loaded = self.store.get(plan.id)
        self.assertEqual(loaded.status, STATUS_PLANNED)
        self.assertEqual(loaded.name, "Invoice Example Corp for July")
        self.assertEqual(loaded.steps[0].argv, self.step.argv)
        self.assertEqual(loaded.agent, "/fake/agents/example-agent")

    def test_plan_files_are_private(self):
        plan = self.create()
        path = os.path.join(self.store.root, plan.id + ".json")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.store.root).st_mode), 0o700)

    def test_create_requires_name_and_steps(self):
        with self.assertRaises(PlanError):
            self.create(name="")
        with self.assertRaises(PlanError):
            self.create(steps=[])

    def test_malformed_id_rejected(self):
        for bad in ("../../etc/passwd", "x", "20260819000000-XYZ"):
            with self.assertRaises(PlanError):
                self.store.get(bad)

    def test_list_orders_by_creation(self):
        first = self.create(name="first")
        self.now[0] += 60
        second = self.create(name="second")
        listed = self.store.list()
        self.assertEqual([p.id for p in listed], [first.id, second.id])

    def test_append_steps_only_while_planned(self):
        plan = self.create()
        extra = Step(toolset="gws", account="personal", argv=["gmail", "users", "messages", "send"])
        updated = self.store.append_steps(plan.id, [extra])
        self.assertEqual(len(updated.steps), 2)
        self.store.reject(plan.id)
        with self.assertRaises(PlanError):
            self.store.append_steps(plan.id, [extra])

    def test_reject(self):
        plan = self.create()
        self.assertEqual(self.store.reject(plan.id).status, STATUS_REJECTED)
        with self.assertRaises(PlanError):
            self.store.runnable(plan.id)
        with self.assertRaises(PlanError):
            self.store.reject(plan.id)  # nothing left to reject

    def test_ttl_expiry_blocks_execution(self):
        plan = self.create()
        self.now[0] += 6 * DAY
        self.assertEqual(self.store.get(plan.id).status, STATUS_PLANNED)
        self.now[0] += 2 * DAY  # now 8 days old, past the 7-day TTL
        self.assertEqual(self.store.get(plan.id).status, STATUS_EXPIRED)
        with self.assertRaises(PlanError):
            self.store.runnable(plan.id)
        # An expired plan can still be tidied away.
        self.assertEqual(self.store.reject(plan.id).status, STATUS_REJECTED)

    def test_mark_executed(self):
        plan = self.create()
        result = {"exit_code": 0, "stdout": "x" * 10_000, "stderr": ""}
        executed = self.store.mark_executed(plan.id, [result])
        self.assertEqual(executed.status, STATUS_EXECUTED)
        self.assertIsNotNone(executed.executed_at)
        self.assertIn("truncated", executed.results[0]["stdout"])
        with self.assertRaises(PlanError):
            self.store.mark_executed(plan.id, [result])  # no double execution
        with self.assertRaises(PlanError):
            self.store.runnable(plan.id)


if __name__ == "__main__":
    sys.exit(unittest.main())
