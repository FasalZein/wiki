#!/usr/bin/env python3
"""Strip dead forge-shell path-qualified wikilinks from vault artifact bodies.

Rule (safe, deterministic):
  1. A "broken path-link" is a [[target|alias]] / [[target]] whose target contains
     a '/' and does not resolve to <vault>/<target> or <vault>/<target>.md.
  2. Remove bullet lines that are ONLY a broken path-link  ("- [[..broken..]] ...").
  3. De-link broken links embedded in other text (tables/prose): replace the
     [[target|alias]] with its alias text (or last path segment) — keeps the row/prose.
  4. After edits, drop any '##'/'###' heading whose section body is now empty
     (blank lines only, until the next heading of same-or-higher level or EOF).
Live links (existing targets) and bare [[ID]] links are untouched.
"""
import re, os, sys, glob

VAULT = os.path.expanduser("~/Knowledge")
DRY = "--dry-run" in sys.argv
ONLY = None
for a in sys.argv[1:]:
    if not a.startswith("--"):
        ONLY = a

WIKILINK = re.compile(r'\[\[([^\]]+)\]\]')

def target_exists(target):
    p = os.path.join(VAULT, target)
    return os.path.exists(p) or os.path.exists(p + ".md")

def is_broken_pathlink(inner):
    # inner is the text between [[ ]]; may have |alias and #heading
    tgt = inner.split("|")[0].split("#")[0].strip()
    if "/" not in tgt and "\\" not in tgt:
        return False, None  # bare id — leave to other checks
    if tgt.startswith(".."):
        return False, None  # relative traversal — skip (worker's doctor skips these too)
    return (not target_exists(tgt)), inner

def alias_of(inner):
    parts = inner.split("|")
    if len(parts) > 1:
        return parts[1].strip()
    tgt = parts[0].split("#")[0].strip().rstrip("/")
    segs = tgt.split("/")
    last = segs[-1]
    # generic leaf names (spec/index/plan/_summary) carry no meaning on their own;
    # use the parent segment (the module/slice name) instead.
    if last in ("spec", "index", "plan", "_summary", "_overview") and len(segs) > 1:
        return segs[-2]
    return last

def line_is_broken_bullet(line):
    s = line.strip()
    if not (s.startswith("- ") or s.startswith("* ")):
        return False
    links = WIKILINK.findall(s)
    if not links:
        return False
    # bullet qualifies for removal only if EVERY wikilink in it is a broken pathlink
    # AND stripping the links + bullet marker leaves no meaningful prose
    broken = [is_broken_pathlink(l)[0] for l in links]
    if not all(broken):
        return False
    # remove bullet marker + all wikilinks + common separators; if nothing meaningful remains, drop
    rest = WIKILINK.sub("", s[2:])
    rest = re.sub(r'[\s\-—–:|·]+', '', rest)
    return rest == ""

def delink_line(line):
    # replace any broken pathlink in the line with its alias text; keep live links
    def repl(m):
        broken, inner = is_broken_pathlink(m.group(1))
        return alias_of(inner) if broken else m.group(0)
    return WIKILINK.sub(repl, line)

HEADING = re.compile(r'^(#{1,6})\s')

def collapse_empty_sections(lines):
    # iteratively remove a heading whose body (until next heading of <= its level) is all blank
    changed = True
    while changed:
        changed = False
        out = []
        i = 0
        while i < len(lines):
            m = HEADING.match(lines[i])
            if m:
                level = len(m.group(1))
                j = i + 1
                body_has_content = False
                while j < len(lines):
                    m2 = HEADING.match(lines[j])
                    if m2 and len(m2.group(1)) <= level:
                        break
                    if lines[j].strip():
                        # a nested heading counts as content only if IT survives; treat non-blank non-heading as content
                        if not HEADING.match(lines[j]):
                            body_has_content = True
                    j += 1
                if not body_has_content:
                    # drop heading i..j (the empty section); keep scanning from j
                    lines = lines[:i] + lines[j:]
                    changed = True
                    break
                else:
                    out.append(lines[i]); i += 1
            else:
                out.append(lines[i]); i += 1
        else:
            continue
    return lines

def process(path):
    txt = open(path, encoding="utf-8", errors="ignore").read()
    lines = txt.splitlines()
    new = []
    removed_bullets = 0
    delinked = 0
    for line in lines:
        if line_is_broken_bullet(line):
            removed_bullets += 1
            continue
        nl = delink_line(line)
        if nl != line:
            delinked += 1
        new.append(nl)
    before_secn = len(new)
    new = collapse_empty_sections(new)
    # squeeze 3+ blank lines to max 2
    out = []
    blanks = 0
    for l in new:
        if l.strip() == "":
            blanks += 1
            if blanks <= 2: out.append(l)
        else:
            blanks = 0; out.append(l)
    result = "\n".join(out)
    if txt.endswith("\n"): result += "\n"
    return result, removed_bullets, delinked

files = []
pat = f"projects/{ONLY}/**/*.md" if ONLY else "projects/*/**/*.md"
for f in glob.glob(os.path.join(VAULT, pat), recursive=True):
    if os.path.basename(f) == "index.md": continue
    files.append(f)

tot_b = tot_d = tot_f = 0
for f in sorted(files):
    res, rb, dl = process(f)
    if rb or dl:
        tot_f += 1; tot_b += rb; tot_d += dl
        if not DRY:
            open(f, "w", encoding="utf-8").write(res)
print(f"{'DRY-RUN ' if DRY else ''}files changed: {tot_f} | bullets removed: {tot_b} | links de-linked: {tot_d}")
