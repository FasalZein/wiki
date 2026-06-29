#!/usr/bin/env bash
# Test-suite default qmd: a no-op that never touches the real ~/.cache/qmd index.
# SLICE-0126 makes every write fire an incremental `qmd update`, so any create-path
# test that does not pin its own QMD_COMMAND must not reach the real `qmd` on PATH
# (which holds real collections like wiki-v2). `collection list` prints nothing so
# ensureCollection treats every collection as new; everything else is a clean exit.
set -euo pipefail
case "${1:-}" in
  collection)
    case "${2:-}" in
      list) : ;;   # no collections — caller registers as needed
      *) : ;;
    esac
    ;;
  query) echo '[]' ;;
  *) : ;;          # update / embed / anything else: no-op
esac
