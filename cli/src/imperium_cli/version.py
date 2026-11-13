from __future__ import annotations

import os
from importlib.metadata import PackageNotFoundError, version


def cli_version() -> str:
    env = os.environ.get("IMPERIUM_CLI_VERSION", "").strip()
    if env:
        return env
    try:
        return version("imperium-cli")
    except PackageNotFoundError:
        return "0.0.0"
