#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

# Count the arguments.
echo args: $#
echo "length: ${#1}" # trailing
echo 'a # inside single quotes'
echo "a # inside double quotes, it's fine"
echo a#b
# shellcheck disable=SC2086
echo $1
