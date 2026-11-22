#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Copyright 2026 Example Authors
# SPDX-License-Identifier: MIT

"""Module docstring that counts."""

import os  # trailing comment counts
from typing import List  # type: ignore


def greet(name: str) -> str:
    """Greet someone.

    Spans four lines.
    """
    url = "http://example.com/#anchor"
    marker = '# not a comment'
    template = """
    # inside a triple-quoted string, not a comment
    """
    count = 1  # noqa: E501
    values = []  # type: List[str]
    return f"{name} # still a string" + url + marker + template + str(count + len(values) + len(os.sep))
