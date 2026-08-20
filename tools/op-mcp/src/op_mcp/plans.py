"""On-disk plan store.

A plan is one *business action* -- e.g. "Invoice Example Corp for July and email
it" -- with a name, an optional area, an ordered list of steps (exact argv each),
the requesting agent's rationale, the requesting agent, and a timestamp. Plans
hold no secrets, so they live as world-invisible (0600) JSON files under the
state directory (default ``~/.local/state/op-mcp/plans/``).

Lifecycle: ``planned`` -> ``rejected`` | ``executed``. A plan still ``planned``
after the TTL reports ``expired`` and can no longer run, so an action built
against stale data cannot linger executable.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import asdict, dataclass, field

STATUS_PLANNED = "planned"
STATUS_REJECTED = "rejected"
STATUS_EXECUTED = "executed"
STATUS_EXPIRED = "expired"

_ID_RE = re.compile(r"^[0-9]{14}-[0-9a-f]{8}$")
# Keep stored step output bounded; plans are an audit trail, not a data store.
_RESULT_TEXT_LIMIT = 8192


class PlanError(Exception):
    """A plan operation failed; str(err) is safe to show the caller."""


@dataclass
class Step:
    toolset: str
    argv: list[str]
    account: str = ""


@dataclass
class Plan:
    id: str
    name: str
    area: str
    rationale: str
    agent: str
    created: float
    steps: list[Step] = field(default_factory=list)
    status: str = STATUS_PLANNED
    executed_at: float | None = None
    results: list[dict] | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _truncate(text: str) -> str:
    if len(text) <= _RESULT_TEXT_LIMIT:
        return text
    return text[:_RESULT_TEXT_LIMIT] + f"... [truncated {len(text) - _RESULT_TEXT_LIMIT} chars]"


class PlanStore:
    def __init__(self, root: str, ttl_days: float = 7.0, clock=time.time):
        self.root = root
        self.ttl_seconds = ttl_days * 86400
        self.clock = clock

    def _ensure_root(self) -> None:
        os.makedirs(self.root, mode=0o700, exist_ok=True)

    def _path(self, plan_id: str) -> str:
        if not _ID_RE.match(plan_id):
            raise PlanError(f"malformed plan id: {plan_id!r}")
        return os.path.join(self.root, plan_id + ".json")

    def _write(self, plan: Plan) -> None:
        self._ensure_root()
        path = self._path(plan.id)
        tmp = path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(plan.to_dict(), handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(tmp, path)

    def _effective_status(self, plan: Plan) -> str:
        if plan.status == STATUS_PLANNED and self.clock() - plan.created > self.ttl_seconds:
            return STATUS_EXPIRED
        return plan.status

    def _load(self, plan_id: str) -> Plan:
        path = self._path(plan_id)
        try:
            with open(path, encoding="utf-8") as handle:
                raw = json.load(handle)
        except FileNotFoundError:
            raise PlanError(f"no such plan: {plan_id}") from None
        except (OSError, json.JSONDecodeError) as err:
            raise PlanError(f"cannot read plan {plan_id}: {err}") from None
        raw["steps"] = [Step(**step) for step in raw.get("steps", [])]
        plan = Plan(**raw)
        plan.status = self._effective_status(plan)
        return plan

    def create(
        self,
        name: str,
        steps: list[Step],
        area: str = "",
        rationale: str = "",
        agent: str = "",
    ) -> Plan:
        if not name:
            raise PlanError("a plan needs a name (the business action it performs)")
        if not steps:
            raise PlanError("a plan needs at least one step")
        now = self.clock()
        plan_id = time.strftime("%Y%m%d%H%M%S", time.gmtime(now)) + "-" + os.urandom(4).hex()
        plan = Plan(
            id=plan_id,
            name=name,
            area=area,
            rationale=rationale,
            agent=agent,
            created=now,
            steps=list(steps),
        )
        self._write(plan)
        return plan

    def get(self, plan_id: str) -> Plan:
        return self._load(plan_id)

    def list(self) -> list[Plan]:
        if not os.path.isdir(self.root):
            return []
        plans = []
        for entry in sorted(os.listdir(self.root)):
            if not entry.endswith(".json"):
                continue
            plan_id = entry[: -len(".json")]
            if not _ID_RE.match(plan_id):
                continue
            plans.append(self._load(plan_id))
        plans.sort(key=lambda plan: plan.created)
        return plans

    def append_steps(self, plan_id: str, steps: list[Step]) -> Plan:
        plan = self._load(plan_id)
        if plan.status != STATUS_PLANNED:
            raise PlanError(f"plan {plan_id} is {plan.status}; only planned plans accept steps")
        plan.steps.extend(steps)
        self._write(plan)
        return plan

    def reject(self, plan_id: str) -> Plan:
        plan = self._load(plan_id)
        if plan.status not in (STATUS_PLANNED, STATUS_EXPIRED):
            raise PlanError(f"plan {plan_id} is {plan.status}; nothing to reject")
        plan.status = STATUS_REJECTED
        self._write(plan)
        return plan

    def runnable(self, plan_id: str) -> Plan:
        """Return the plan iff it may be executed right now."""
        plan = self._load(plan_id)
        if plan.status != STATUS_PLANNED:
            raise PlanError(f"plan {plan_id} is {plan.status}; only planned plans can run")
        return plan

    def mark_executed(self, plan_id: str, results: list[dict]) -> Plan:
        plan = self.runnable(plan_id)
        plan.status = STATUS_EXECUTED
        plan.executed_at = self.clock()
        plan.results = [
            {
                **result,
                "stdout": _truncate(result.get("stdout", "")),
                "stderr": _truncate(result.get("stderr", "")),
            }
            for result in results
        ]
        self._write(plan)
        return plan
