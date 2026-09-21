"""Thin Moodle web-service client.

One transport for every tool: a GET to /webservice/rest/server.php with the token,
the function name and Moodle's peculiar array parameter encoding.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

# httpx logs every request line at INFO, including the full URL. Even with the
# token moved to the POST body, keep the client quiet: request logs are the
# classic way a credential ends up in a terminal scrollback or a bug report.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def redact(text: str, secret: str) -> str:
    """Never let a token reach a log line or an exception message."""
    return text.replace(secret, "<token>") if secret else text


class MoodleError(RuntimeError):
    def __init__(self, code: str, message: str, function: str):
        self.code, self.message, self.function = code, message, function
        super().__init__(f"Moodle error [{code}] in {function}: {message}")


def flatten(prefix: str, value: Any, out: dict[str, Any]) -> None:
    """Moodle wants nested structures as name[0][key]=value, not JSON."""
    if isinstance(value, dict):
        for k, v in value.items():
            flatten(f"{prefix}[{k}]", v, out)
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            flatten(f"{prefix}[{i}]", v, out)
    elif isinstance(value, bool):
        out[prefix] = 1 if value else 0
    elif value is not None:
        out[prefix] = value


class Moodle:
    def __init__(self, url: str | None = None, token: str | None = None):
        self.url = (url or os.environ.get("MOODLE_URL", "")).strip()
        self.token = (token or os.environ.get("MOODLE_TOKEN", "")).strip()
        if not self.url or not self.token:
            raise RuntimeError(
                "MOODLE_URL and MOODLE_TOKEN must be set. "
                "Run scripts/get-moodle-token.sh in the ese-qnb repo."
            )

    def call(self, function: str, **params: Any) -> Any:
        # The token goes in the POST body, never in the query string: a URL is
        # echoed by httpx's INFO log, by proxies and by server access logs, and
        # a Moodle token is a bearer credential with the caller's full rights.
        form: dict[str, Any] = {
            "wstoken": self.token,
            "wsfunction": function,
            "moodlewsrestformat": "json",
        }
        for key, value in params.items():
            flatten(key, value, form)

        try:
            response = httpx.post(self.url, data=form, timeout=60)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise MoodleError("transport", redact(str(exc), self.token), function) from None
        data = response.json()

        if isinstance(data, dict) and "errorcode" in data:
            raise MoodleError(data["errorcode"], data.get("message", ""), function)
        if isinstance(data, dict) and data.get("exception"):
            raise MoodleError(data.get("errorcode", "exception"), data.get("message", ""), function)
        return data
