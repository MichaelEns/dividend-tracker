#!/usr/bin/env python3
"""Convenience wrapper so the pipeline can be run as `python build.py`."""

import sys

from divtracker.build import main

if __name__ == "__main__":
    sys.exit(main())
