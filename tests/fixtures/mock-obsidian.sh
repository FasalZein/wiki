#!/bin/bash
# Mock obsidian CLI for testing
CMD="$1"
shift

case "$CMD" in
  version)
    echo "1.12.7"
    ;;
  create)
    folder=""
    name=""
    content=""
    for arg in "$@"; do
      case "$arg" in
        name=*) name="${arg#name=}" ;;
        folder=*) folder="${arg#folder=}" ;;
        content=*) content="${arg#content=}" ;;
      esac
    done
    if [ -n "$KNOWLEDGE_VAULT_ROOT" ] && [ -n "$folder" ] && [ -n "$name" ]; then
      dest="${KNOWLEDGE_VAULT_ROOT}/${folder}/${name}.md"
      mkdir -p "$(dirname "$dest")"
      printf '%s' "$content" > "$dest"
    fi
    echo "Created: ${folder}/${name}.md"
    ;;
  read)
    echo "---"
    echo "title: Mock Note"
    echo "---"
    echo "# Mock Content"
    echo "This is mock content."
    ;;
  append)
    # silent success
    ;;
  property:set)
    pname=""
    pvalue=""
    for arg in "$@"; do
      case "$arg" in
        name=*) pname="${arg#name=}" ;;
        value=*) pvalue="${arg#value=}" ;;
      esac
    done
    echo "Set ${pname}: ${pvalue}"
    ;;
  property:read)
    pname=""
    for arg in "$@"; do
      case "$arg" in
        name=*) pname="${arg#name=}" ;;
      esac
    done
    echo "accepted"
    ;;
  search)
    echo '[{"path":"notes/test.md","score":0.9}]'
    ;;
  eval)
    code=""
    for arg in "$@"; do
      case "$arg" in
        code=*) code="${arg#code=}" ;;
      esac
    done
    echo "=> 42"
    ;;
  plugin:install)
    echo "Installed"
    ;;
  plugin:enable)
    echo "Enabled"
    ;;
  command)
    echo "Executed"
    ;;
  error-test)
    echo "Error: something went wrong"
    ;;
  *)
    echo "Error: unknown command '$CMD'"
    ;;
esac
