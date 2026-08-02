"""Account-isolated IBKR Flex history fetcher.

The Flex token is read from stdin and is never accepted through argv or the
environment. Errors deliberately omit request URLs and upstream response text.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from typing import Callable
from urllib.parse import urlencode
from urllib.request import Request, urlopen


FLEX_BASE_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
MAX_CHUNK_DAYS = 365
MAX_ATTEMPTS = 5
RETRY_DELAY_SECONDS = 2
HTTP_TIMEOUT_SECONDS = 30
CHUNK_REQUEST_DELAY_SECONDS = 6


class FlexError(RuntimeError):
    """A sanitized error safe to show to the local caller."""


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _format_date(value: str) -> str:
    value = value.strip()
    if len(value) >= 8 and value[:8].isdigit():
        return f"{value[0:4]}-{value[4:6]}-{value[6:8]}"
    return value


def _to_float(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def split_date_range(start: date, end: date) -> list[tuple[date, date]]:
    """Split an inclusive range into non-overlapping 365-day chunks."""
    if start > end:
        raise FlexError("start date must not be after end date")

    chunks = []
    current = start
    while current <= end:
        chunk_end = min(current + timedelta(days=MAX_CHUNK_DAYS - 1), end)
        chunks.append((current, chunk_end))
        current = chunk_end + timedelta(days=1)
    return chunks


def _statement_account(statement: ET.Element) -> str:
    account = (statement.attrib.get("accountId") or "").strip()
    if not account:
        raise FlexError("Flex statement does not identify an account")
    return account


def _row_account(element: ET.Element, statement_account: str) -> str:
    account = (element.attrib.get("accountId") or statement_account).strip()
    if account != statement_account:
        raise FlexError("Flex query returned a different account than requested")
    return account


def _parse_trade(element: ET.Element, account: str) -> dict[str, object] | None:
    attributes = element.attrib
    symbol = (attributes.get("symbol") or "").strip()
    if not symbol:
        return None
    raw_date = attributes.get("tradeDate") or attributes.get("dateTime", "").split(";")[0]
    return {
        "account": _row_account(element, account),
        "trade_date": _format_date(raw_date) if raw_date else None,
        "symbol": symbol,
        "description": (attributes.get("description") or "").strip() or None,
        "buy_sell": (attributes.get("buySell") or "UNK").strip().upper(),
        "quantity": abs(_to_float(attributes.get("quantity"))),
        "price": _to_float(attributes.get("tradePrice")),
        "proceeds": _to_float(attributes.get("proceeds")),
        "commission": _to_float(attributes.get("ibCommission") or attributes.get("commission")),
        "net_cash": _to_float(attributes.get("netCash")),
        "realized_pnl": _to_float(attributes.get("fifoPnlRealized")),
        "currency": (attributes.get("currency") or "USD").strip(),
    }


def _parse_dividend(element: ET.Element, account: str) -> dict[str, object] | None:
    attributes = element.attrib
    amount = _to_float(attributes.get("amount"))
    if amount == 0:
        return None
    raw_date = attributes.get("reportDate") or attributes.get("dateTime", "").split(";")[0]
    return {
        "account": _row_account(element, account),
        "date": _format_date(raw_date) if raw_date else "",
        "symbol": (attributes.get("symbol") or "").strip() or None,
        "description": (attributes.get("description") or "").strip() or None,
        "type": (attributes.get("type") or "").strip(),
        "amount": amount,
        "currency": (attributes.get("currency") or "USD").strip(),
    }


def _parse_transfer(element: ET.Element, account: str) -> dict[str, object] | None:
    attributes = element.attrib
    activity_code = (attributes.get("activityCode") or "").strip().upper()
    transfer_types = {"DEP": "DEPOSIT", "WITH": "WITHDRAWAL", "TRANS": "TRANSFER"}
    if activity_code not in transfer_types:
        return None
    amount = _to_float(attributes.get("amount"))
    if amount == 0:
        return None
    raw_date = attributes.get("reportDate") or attributes.get("date") or ""
    return {
        "account": _row_account(element, account),
        "date": _format_date(raw_date) if raw_date else "",
        "type": transfer_types[activity_code],
        "amount": amount,
        "currency": (attributes.get("currency") or "USD").strip(),
        "description": (attributes.get("description") or "").strip() or None,
    }


def _statements(xml: str) -> list[ET.Element]:
    try:
        root = ET.fromstring(xml.strip())
    except ET.ParseError:
        raise FlexError("IBKR returned invalid Flex XML") from None

    statements = [element for element in root.iter() if _local_name(element.tag) == "FlexStatement"]
    if not statements:
        raise FlexError("Flex response does not contain a statement")
    return statements


def parse_statement(
    xml: str, kind: str, expected_account: str | None
) -> list[dict[str, object]]:
    """Parse statements and optionally retain only one identified account."""
    parsers = {
        "trades": ("Trade", _parse_trade, "trade_date"),
        "transfers": ("StatementOfFundsLine", _parse_transfer, "date"),
        "dividends": ("CashTransaction", _parse_dividend, "date"),
    }
    if kind not in parsers:
        raise FlexError("unsupported Flex history kind")

    statements = _statements(xml)

    statement_accounts = {_statement_account(statement) for statement in statements}
    if expected_account is not None and expected_account not in statement_accounts:
        raise FlexError("requested account is not present in the Flex statement")

    element_name, parser, sort_key = parsers[kind]
    rows = []
    for statement in statements:
        account = _statement_account(statement)
        if expected_account is not None and account != expected_account:
            continue
        for element in statement.iter():
            if _local_name(element.tag) != element_name:
                continue
            row = parser(element, account)
            if row is not None:
                rows.append(row)

    rows.sort(key=lambda row: str(row.get(sort_key) or ""), reverse=True)
    return rows


def fetch_history(
    token: str,
    query_id: str,
    kind: str,
    expected_account: str | None,
    start: date,
    end: date,
    request: Callable[[str, str, date, date], str],
    pause: Callable[[float], None] = time.sleep,
) -> dict[str, object]:
    """Fetch and merge an exact historical window."""
    rows = []
    chunks = split_date_range(start, end)
    for index, (chunk_start, chunk_end) in enumerate(chunks):
        if index:
            pause(CHUNK_REQUEST_DELAY_SECONDS)
        xml = request(token, query_id, chunk_start, chunk_end)
        rows.extend(parse_statement(xml, kind, expected_account))

    sort_key = "trade_date" if kind == "trades" else "date"
    rows.sort(key=lambda row: str(row.get(sort_key) or ""), reverse=True)
    return {
        "rows": rows,
        "count": len(rows),
        "account": expected_account,
        "from_date": start.isoformat(),
        "to_date": end.isoformat(),
        "chunks": len(chunks),
    }


def fetch_raw(
    token: str,
    query_id: str,
    start: date,
    end: date,
    request: Callable[[str, str, date, date], str],
    pause: Callable[[float], None] = time.sleep,
) -> dict[str, object]:
    """Fetch an exact historical window as unparsed statement XML chunks.

    Each chunk is verified to be well-formed Flex XML containing at least one
    account-identified statement, but rows are neither parsed nor filtered;
    the caller owns validation and account-coverage checks.
    """
    chunks = []
    for index, (chunk_start, chunk_end) in enumerate(split_date_range(start, end)):
        if index:
            pause(CHUNK_REQUEST_DELAY_SECONDS)
        xml = request(token, query_id, chunk_start, chunk_end)
        for statement in _statements(xml):
            _statement_account(statement)
        chunks.append(
            {
                "from": chunk_start.isoformat(),
                "to": chunk_end.isoformat(),
                "xml": xml,
            }
        )
    return {
        "from_date": start.isoformat(),
        "to_date": end.isoformat(),
        "chunk_count": len(chunks),
        "chunks": chunks,
    }


def _http_get(url: str) -> str:
    request = Request(url, headers={"User-Agent": "ibkr-local/1.0"})
    with urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        return response.read().decode("utf-8")


def _response_value(xml: str, name: str) -> str | None:
    try:
        root = ET.fromstring(xml.strip())
    except ET.ParseError:
        raise FlexError("IBKR returned an invalid Flex service response") from None
    for element in root.iter():
        if _local_name(element.tag) == name and element.text:
            return element.text.strip()
    return None


def request_statement(token: str, query_id: str, start: date, end: date) -> str:
    """Run the two-step Flex Web Service request for one date chunk."""
    request_query = urlencode(
        {
            "t": token,
            "q": query_id,
            "v": "3",
            "fd": start.strftime("%Y%m%d"),
            "td": end.strftime("%Y%m%d"),
        }
    )
    try:
        response = _http_get(f"{FLEX_BASE_URL}/SendRequest?{request_query}")
    except Exception:
        raise FlexError("unable to contact the IBKR Flex service") from None

    reference_code = _response_value(response, "ReferenceCode")
    if not reference_code:
        error_code = _response_value(response, "ErrorCode")
        suffix = f" (code {error_code})" if error_code and error_code.isdigit() else ""
        raise FlexError(f"IBKR rejected the Flex request{suffix}")

    statement_query = urlencode({"q": reference_code, "t": token, "v": "3"})
    for attempt in range(MAX_ATTEMPTS):
        try:
            statement = _http_get(f"{FLEX_BASE_URL}/GetStatement?{statement_query}")
        except Exception:
            raise FlexError("unable to contact the IBKR Flex service") from None
        error_code = _response_value(statement, "ErrorCode")
        if error_code == "1019" and attempt + 1 < MAX_ATTEMPTS:
            time.sleep(RETRY_DELAY_SECONDS)
            continue
        if error_code:
            suffix = f" (code {error_code})" if error_code.isdigit() else ""
            raise FlexError(f"IBKR rejected the Flex statement{suffix}")
        return statement

    raise FlexError("IBKR Flex statement generation timed out")


def _parse_iso_date(value: str, option: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise FlexError(f"{option} must use YYYY-MM-DD") from None


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch IBKR Flex history")
    parser.add_argument("--query-id", required=True)
    parser.add_argument(
        "--kind", required=True, choices=("trades", "transfers", "dividends", "raw")
    )
    parser.add_argument("--account")
    parser.add_argument("--from-date", required=True)
    parser.add_argument("--to-date", required=True)
    arguments = parser.parse_args()

    token = sys.stdin.read()
    try:
        if not token:
            raise FlexError("Flex token input is empty")
        if not arguments.query_id.isdigit():
            raise FlexError("Flex query ID must contain only digits")
        start = _parse_iso_date(arguments.from_date, "--from")
        end = _parse_iso_date(arguments.to_date, "--to")
        if arguments.kind == "raw":
            if arguments.account:
                raise FlexError(
                    "--account is not supported for raw statements; "
                    "the caller validates account coverage"
                )
            payload = fetch_raw(
                token,
                arguments.query_id,
                start,
                end,
                request_statement,
            )
        else:
            payload = fetch_history(
                token,
                arguments.query_id,
                arguments.kind,
                arguments.account,
                start,
                end,
                request_statement,
            )
        print(json.dumps(payload, separators=(",", ":")))
        return 0
    except FlexError as error:
        print(f"ibkr-flex-fetch: {error}", file=sys.stderr)
        return 1
    except Exception:
        print("ibkr-flex-fetch: unexpected Flex history failure", file=sys.stderr)
        return 1
    finally:
        token = ""


if __name__ == "__main__":
    raise SystemExit(main())
