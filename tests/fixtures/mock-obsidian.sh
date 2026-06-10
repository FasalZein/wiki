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
    ppath=""
    pname=""
    pvalue=""
    ptype=""
    for arg in "$@"; do
      case "$arg" in
        path=*) ppath="${arg#path=}" ;;
        name=*) pname="${arg#name=}" ;;
        value=*) pvalue="${arg#value=}" ;;
        type=*) ptype="${arg#type=}" ;;
      esac
    done
    # Apply the property to the file's frontmatter like the real CLI does
    dest="${KNOWLEDGE_VAULT_ROOT}/${ppath}"
    if [ -n "$KNOWLEDGE_VAULT_ROOT" ] && [ -n "$ppath" ] && [ -n "$pname" ] && [ -f "$dest" ]; then
      awk -v key="$pname" -v val="$pvalue" -v vtype="$ptype" '
        BEGIN { infm = 0; skipping = 0 }
        NR == 1 && /^---$/ { infm = 1; print; next }
        infm == 1 && /^---$/ {
          if (vtype == "list") {
            n = split(val, parts, ",")
            print key ":"
            for (i = 1; i <= n; i++) print "  - " parts[i]
          } else {
            print key ": " val
          }
          infm = 0; print; next
        }
        infm == 1 {
          if (index($0, key ":") == 1) { skipping = 1; next }
          if (skipping == 1) {
            if ($0 ~ /^[ \t]+- /) next
            skipping = 0
          }
          print; next
        }
        { print }
      ' "$dest" > "${dest}.tmp" && mv "${dest}.tmp" "$dest"
    fi
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
    # Handle vault.create/modify calls from obsidianCreate
    if echo "$code" | grep -q 'app.vault.create\|app.vault.modify'; then
      # Extract path between const p=" and ";
      vpath=$(echo "$code" | grep -o 'const p="[^"]*"' | sed 's/const p="//;s/"//')
      # Extract content between const c=` and `;
      vcontent=$(echo "$code" | sed 's/.*const c=`//;s/`;const e=.*//')
      # Unescape
      vcontent=$(printf '%s' "$vcontent" | sed 's/\\`/`/g;s/\\\$/$/g;s/\\\\/\\/g')
      if [ -n "$KNOWLEDGE_VAULT_ROOT" ] && [ -n "$vpath" ]; then
        dest="${KNOWLEDGE_VAULT_ROOT}/${vpath}"
        mkdir -p "$(dirname "$dest")"
        printf '%s' "$vcontent" > "$dest"
      fi
      echo "=> ${vpath}"
    elif echo "$code" | grep -q 'app.vault.setConfig'; then
      echo "=> undefined"
    else
      echo "=> 42"
    fi
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
