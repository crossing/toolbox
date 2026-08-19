"""In-memory token store, loaded eagerly from 1Password at service start.

Eager, not lazy: the one ``safe-op`` read per configured item happens while the
human who started the service is present to authorize the desktop app. A lazy
read mid-run would prompt while nobody is there and fail. After ``load()`` the
steady state never touches ``op``; access tokens are minted in-process from the
in-memory client credentials.

The one exception: if a provider rotates the refresh token, it is written back to
the 1Password item *immediately* via ``op item edit`` -- this rare event may
prompt, and better a prompt than a lost credential.

Nothing here ever prints a secret; reads go through safe-op with stdout a pipe.
"""

from __future__ import annotations

import json
import subprocess
import threading
import time

from op_mcp import oauth
from op_mcp.config import Config

# Mint a fresh Google token when fewer than this many seconds remain (matches
# op-gws.sh's EXPIRY_SKEW).
EXPIRY_SKEW = 300

_GWS_FIELDS = ("gws_client_id", "gws_client_secret", "gws_refresh_token")
_FREEAGENT_FIELDS = ("client_id", "client_secret", "refresh_token")


class SecretsError(Exception):
    """A credential could not be loaded or refreshed; str(err) is transcript-safe."""


class _Credential:
    def __init__(self, item: str, client_id: str, client_secret: str, refresh_token: str):
        self.item = item
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_token = refresh_token
        self.access_token = ""
        self.expires_at = 0.0


def _fields_by_label(item_json: str) -> dict[str, str]:
    try:
        payload = json.loads(item_json)
        fields = {}
        for entry in payload.get("fields", []):
            label = entry.get("label")
            value = entry.get("value")
            if label and value is not None and label not in fields:
                fields[label] = value
        return fields
    except (json.JSONDecodeError, AttributeError):
        raise SecretsError("unparseable op item payload") from None


class TokenStore:
    def __init__(self, config: Config, run=subprocess.run, http=oauth.post_form, clock=time.time):
        self.config = config
        self.run = run
        self.http = http
        self.clock = clock
        self._lock = threading.Lock()
        self._gws: dict[str, _Credential] = {}
        self._freeagent: _Credential | None = None

    # -- eager load -------------------------------------------------------------

    def _op_item_get(self, item: str) -> dict[str, str]:
        command = [*self.config.safe_op_cmd, "item", "get", item]
        if self.config.vault:
            command += ["--vault", self.config.vault]
        command += ["--format", "json"]
        try:
            result = self.run(command, capture_output=True, text=True, check=False)
        except OSError as err:
            raise SecretsError(f"cannot execute {command[0]}: {err}") from None
        if result.returncode != 0:
            raise SecretsError(
                f"op read failed for item '{item}' (exit {result.returncode}); "
                "is the 1Password desktop app unlocked?"
            )
        return _fields_by_label(result.stdout)

    def load(self, progress=None) -> None:
        """Read every configured item once, while the human is present."""

        def note(message: str) -> None:
            if progress:
                progress(message)

        gws = self.config.toolsets.get("gws")
        if gws:
            for account, spec in gws.accounts.items():
                note(f"reading 1Password item for gws account '{account}'")
                fields = self._op_item_get(spec.item)
                missing = [name for name in _GWS_FIELDS if not fields.get(name)]
                if missing or fields.get("gws_refresh_token") == "REPLACE_ME":
                    raise SecretsError(
                        f"item '{spec.item}' is missing {missing or ['gws_refresh_token']}; "
                        "see the op-gws skill for account onboarding"
                    )
                credential = _Credential(
                    spec.item,
                    fields["gws_client_id"],
                    fields["gws_client_secret"],
                    fields["gws_refresh_token"],
                )
                # Seed from the item's cached token when it is still fresh, so the
                # first tool call needs no network round-trip.
                expires_at = fields.get("gws_expires_at", "")
                if fields.get("gws_access_token") and expires_at.isdigit():
                    credential.access_token = fields["gws_access_token"]
                    credential.expires_at = float(expires_at)
                self._gws[account] = credential

        freeagent = self.config.toolsets.get("freeagent")
        if freeagent:
            note("reading 1Password item for freeagent")
            fields = self._op_item_get(freeagent.item)
            missing = [name for name in _FREEAGENT_FIELDS if not fields.get(name)]
            if missing:
                raise SecretsError(
                    f"item '{freeagent.item}' is missing {missing}; "
                    "run the interactive op-oauth2c flow first"
                )
            credential = _Credential(
                freeagent.item,
                fields["client_id"],
                fields["client_secret"],
                fields["refresh_token"],
            )
            credential.access_token = fields.get("access_token", "")
            self._freeagent = credential

    # -- refresh-token rotation write-back ---------------------------------------

    def _write_back_refresh_token(self, credential: _Credential, label: str) -> None:
        command = [*self.config.op_cmd, "item", "edit", credential.item]
        if self.config.vault:
            command += ["--vault", self.config.vault]
        command += [f"{label}[password]={credential.refresh_token}"]
        try:
            result = self.run(command, capture_output=True, text=True, check=False)
        except OSError as err:
            raise SecretsError(f"cannot execute {command[0]}: {err}") from None
        if result.returncode != 0:
            # The new refresh token is live in memory; losing the write-back is
            # recoverable while the service runs, so warn loudly but do not die.
            raise SecretsError(
                f"failed to write rotated refresh token back to item '{credential.item}'; "
                "re-run the interactive onboarding if the service stops before this succeeds"
            )

    # -- token access ------------------------------------------------------------

    def gws_accounts(self) -> list[str]:
        return sorted(self._gws)

    def gws_token(self, account: str) -> str:
        with self._lock:
            credential = self._gws.get(account)
            if credential is None:
                raise SecretsError(f"gws account '{account}' is not configured")
            now = self.clock()
            if credential.access_token and credential.expires_at > now + EXPIRY_SKEW:
                return credential.access_token
            endpoint = self.config.toolsets["gws"].token_endpoint
            response = oauth.refresh_google(
                endpoint,
                credential.client_id,
                credential.client_secret,
                credential.refresh_token,
                http=self.http,
            )
            credential.access_token = response["access_token"]
            expires_in = response.get("expires_in")
            credential.expires_at = now + (
                float(expires_in) if isinstance(expires_in, (int, float)) else 3600
            )
            rotated = response.get("refresh_token")
            if rotated and rotated != credential.refresh_token:
                credential.refresh_token = rotated
                self._write_back_refresh_token(credential, "gws_refresh_token")
            return credential.access_token

    def freeagent_token(self) -> str:
        with self._lock:
            credential = self._require_freeagent()
            if not credential.access_token:
                return self._refresh_freeagent_locked(credential)
            return credential.access_token

    def refresh_freeagent(self) -> str:
        with self._lock:
            return self._refresh_freeagent_locked(self._require_freeagent())

    def _require_freeagent(self) -> _Credential:
        if self._freeagent is None:
            raise SecretsError("freeagent toolset is not configured")
        return self._freeagent

    def _refresh_freeagent_locked(self, credential: _Credential) -> str:
        endpoint = self.config.toolsets["freeagent"].token_endpoint
        response = oauth.refresh_client_secret_basic(
            endpoint,
            credential.client_id,
            credential.client_secret,
            credential.refresh_token,
            http=self.http,
        )
        credential.access_token = response["access_token"]
        rotated = response.get("refresh_token")
        if rotated and rotated != credential.refresh_token:
            credential.refresh_token = rotated
            self._write_back_refresh_token(credential, "refresh_token")
        return credential.access_token
