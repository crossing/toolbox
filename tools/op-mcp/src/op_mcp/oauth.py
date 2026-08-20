"""In-process OAuth refresh grants (Google + FreeAgent).

These mirror the shapes of tools/op-gws/op-gws.sh (Google: form-encoded refresh
grant, credentials in the body) and tools/op-oauth2c/op-oauth2c.sh via oauth2c
(FreeAgent: refresh grant with ``client_secret_basic`` auth). Doing the exchange
in-process is what lets steady state never touch ``op``: the client credentials
live in server memory, so the vault re-locking is irrelevant.

Errors are sanitized: only the OAuth ``error``/``error_description`` fields are
surfaced, never a raw response body that could echo a credential.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request


class OAuthError(Exception):
    """Token endpoint rejected the refresh; str(err) is transcript-safe."""


def _sanitized_error(body: bytes) -> str:
    try:
        payload = json.loads(body)
        error = payload.get("error", "unknown")
        description = payload.get("error_description", "no description")
        return f"{error}: {description}"
    except (json.JSONDecodeError, AttributeError):
        return "unparseable token endpoint response"


def post_form(
    url: str, data: dict[str, str], headers: dict[str, str] | None = None, timeout: float = 30
) -> dict:
    """POST a form and return the parsed JSON response. Stub point for tests."""
    request = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(data).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as err:
        raise OAuthError(_sanitized_error(err.read())) from None
    except urllib.error.URLError as err:
        raise OAuthError(f"token endpoint unreachable: {err.reason}") from None
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise OAuthError("unparseable token endpoint response") from None
    if not isinstance(payload, dict) or not payload.get("access_token"):
        raise OAuthError(_sanitized_error(body))
    return payload


def refresh_google(
    endpoint: str, client_id: str, client_secret: str, refresh_token: str, http=post_form
) -> dict:
    """Google-style refresh grant: credentials in the form body."""
    return http(
        endpoint,
        {
            "grant_type": "refresh_token",
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
        },
    )


def refresh_client_secret_basic(
    endpoint: str, client_id: str, client_secret: str, refresh_token: str, http=post_form
) -> dict:
    """FreeAgent-style refresh grant: HTTP Basic client authentication."""
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    return http(
        endpoint,
        {"grant_type": "refresh_token", "refresh_token": refresh_token},
        headers={"Authorization": f"Basic {basic}"},
    )
