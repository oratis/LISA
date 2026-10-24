#!/usr/bin/env python3
"""Check public Cloud endpoints without credentials or reading user data.

Uses an honest client identifier: urllib's default Python User-Agent can be
rejected by Cloudflare Browser Integrity Check before reaching the app.
Pass --user-agent Python-urllib/3.9 to reproduce that diagnostic separately.
This checks availability/configuration, not sign-in or successful AI inference.
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


def check(base, path, user_agent):
    request = urllib.request.Request(
        base + path,
        headers={"User-Agent": user_agent, "Accept": "application/json"},
    )
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return {
            "path": path,
            "ok": False,
            "reason": "network_error",
            "error_type": type(error).__name__,
        }

    with response:
        body = response.read(65536).decode("utf-8", errors="replace")
        result = {"path": path, "status": response.status, "ok": False}
        if response.headers.get("CF-Ray"):
            result["cf_ray"] = response.headers["CF-Ray"]
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = None
        edge_1010 = (
            isinstance(data, dict)
            and data.get("cloudflare_error") is True
            and data.get("error_code") == 1010
        )
        if response.status == 403 and ("error code: 1010" in body or edge_1010):
            return {**result, "reason": "cloudflare_browser_signature_block"}
        if response.status != 200:
            return {**result, "reason": "http_error"}
        if data is None:
            return {**result, "reason": "invalid_json"}
        if not isinstance(data, dict):
            return {**result, "reason": "unexpected_response"}
        if path == "/health":
            valid = data.get("ok") is True and data.get("edition") == "cloud"
        else:
            processing = data.get("dataProcessing")
            recipients = (
                processing.get("recipients") if isinstance(processing, dict) else None
            )
            valid = (
                data.get("accounts") is True
                and isinstance(recipients, list)
                and bool(recipients)
                and all(isinstance(item, str) and item.strip() for item in recipients)
            )
        return {
            **result,
            "ok": valid,
            "reason": "ready" if valid else "unexpected_response",
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="https://cloud.meetlisa.ai")
    parser.add_argument("--user-agent", default="LISA-HealthCheck/1.0")
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.base)
    if (
        url.scheme != "https"
        or not url.netloc
        or url.username
        or url.password
        or url.query
        or url.fragment
        or url.path not in ("", "/")
    ):
        parser.error(
            "--base must be an HTTPS origin without credentials, path, query or fragment"
        )
    results = [
        check(args.base.rstrip("/"), path, args.user_agent)
        for path in ("/health", "/api/auth/config")
    ]
    print(json.dumps(
        {"base": args.base, "user_agent": args.user_agent, "checks": results}, indent=2
    ))
    return 0 if all(result["ok"] for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
