#!/usr/bin/env python3
"""Filesystem-only wrangler put/get adapter for synthetic backup artifacts."""

import argparse
import os
from pathlib import Path
import re
import shutil
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("r2", choices=["r2"])
    parser.add_argument("object", choices=["object"])
    parser.add_argument("operation", choices=["put", "get"])
    parser.add_argument("key")
    parser.add_argument("--file", required=True)
    parser.add_argument("--remote", action="store_true", required=True)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--jurisdiction", choices=["eu"], required=True)
    args = parser.parse_args()
    if not re.fullmatch(
        r"synthetic-proof/proof/synthetic-synthetic(?:/MANIFEST\.txt|-\d{8}T\d{6}Z\.dump)",
        args.key,
    ):
        return 2
    root = Path(os.environ["FAKE_R2_ROOT"])
    destination = root / args.key
    if args.operation == "put":
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.file, destination)
    else:
        if not destination.is_file():
            return 1
        shutil.copyfile(destination, args.file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
