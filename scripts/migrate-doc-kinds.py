#!/usr/bin/env python3
"""One-off doc-kind promotion migration (PRD-0023 vault reconciliation).

Promotes the six former `doc` buckets to first-class kinds with their own id
prefix and top-level folder. Per project:
  - RETIRE confirmed roster docs (deleted; sync regenerates index.md).
  - Re-id remaining docs: DOC-NNNN -> <PREFIX>-NNNN (number preserved, prefix by
    bucket), rewrite frontmatter id + aliases, move docs/<bucket>/file -> <bucket>/file.
  - Rewrite every intra-project DOC-NNNN reference via the per-project map.
  - Flag any unmapped DOC-NNNN ref (retired target or cross-project) — never silently drop.

Usage:
  migrate-doc-kinds.py <project>            # dry-run (prints plan)
  migrate-doc-kinds.py <project> --write    # apply
"""
import os, re, sys, glob, shutil

ROOT = os.path.expanduser(os.environ.get("KNOWLEDGE_VAULT_ROOT", "~/Knowledge"))
BUCKET_PREFIX = {"architecture":"ARCH","research":"RES","runbooks":"RUN",
                 "specs":"SPEC","notes":"NOTE","legacy":"LEG"}

# Body-confirmed retire list (Claude+GLM workers). Per project -> set of DOC ids.
RETIRE = {
  "ymcq": {"DOC-0039","DOC-0040","DOC-0043","DOC-0059"},
  "desloppify": {"DOC-0096","DOC-0095","DOC-0115","DOC-0272","DOC-0043"},
  "gii-mvp": {"DOC-0058","DOC-0057","DOC-0063","DOC-0130","DOC-0030"},
  "rift": {"DOC-0146","DOC-0145","DOC-0147","DOC-0148","DOC-0062"},
  "arcseye": {"DOC-0015","DOC-0014","DOC-0021","DOC-0030","DOC-0009"},
  "design-md": {"DOC-0027","DOC-0026","DOC-0029","DOC-0033","DOC-0012"},
  "hermes-ops": {"DOC-0044","DOC-0043","DOC-0045","DOC-0046"},
  "pi-subagents": {"DOC-0017","DOC-0016","DOC-0020","DOC-0027","DOC-0008","DOC-0009"},
  "pi-memory": {"DOC-0005","DOC-0006"},
}

ref_re = re.compile(r'(?<![A-Za-z])DOC-\d+')

def migrate(proj, write):
    pdir = f"{ROOT}/projects/{proj}"
    retire = RETIRE.get(proj, set())
    docmap = {}          # DOC-NNNN -> new id
    moves = []           # (oldpath, newpath, did, newid)
    retired, no_id, unknown = [], [], []

    for f in glob.glob(f"{pdir}/docs/**/*.md", recursive=True):
        if f.endswith("/index.md"): continue
        txt = open(f, encoding="utf-8").read()
        m = re.search(r'^id:\s*(DOC-\d+)', txt, re.M)
        if not m: no_id.append(f); continue
        did = m.group(1); num = did.split("-")[1]
        bkm = re.search(r'/docs/([^/]+)/', f)
        bucket = bkm.group(1) if bkm else None
        prefix = BUCKET_PREFIX.get(bucket)
        if not prefix: unknown.append((bucket, f)); continue
        if did in retire:
            retired.append(f); continue
        newid = f"{prefix}-{num}"
        docmap[did] = newid
        base = os.path.basename(f)
        newbase = re.sub(r'^DOC-\d+', newid, base)
        moves.append((f, f"{pdir}/{bucket}/{newbase}", did, newid))

    # Apply retires first (delete file; sync owns index regen)
    if write:
        for f in retired: os.remove(f)

    # Re-id + move
    for old, new, did, newid in moves:
        txt = open(old, encoding="utf-8").read()
        txt = re.sub(r'^(id:\s*)DOC-\d+', rf'\g<1>{newid}', txt, count=1, flags=re.M)
        # aliases entry equal to old id
        txt = re.sub(rf'(-\s*){re.escape(did)}\b', rf'\g<1>{newid}', txt)
        if write:
            os.makedirs(os.path.dirname(new), exist_ok=True)
            open(old, "w", encoding="utf-8").write(txt)
            shutil.move(old, new)

    # Rewrite intra-project references everywhere in the project
    unmapped = {}
    target_files = glob.glob(f"{pdir}/**/*.md", recursive=True)
    for f in target_files:
        if not os.path.exists(f): continue
        txt = open(f, encoding="utf-8").read()
        def repl(mm):
            tok = mm.group(0)
            if tok in docmap: return docmap[tok]
            if tok in retire: unmapped.setdefault(tok, []).append((os.path.basename(f),"->retired")); return tok
            unmapped.setdefault(tok, []).append((os.path.basename(f),"unmapped")); return tok
        new_txt = ref_re.sub(repl, txt)
        if write and new_txt != txt:
            open(f, "w", encoding="utf-8").write(new_txt)

    # Remove now-empty docs/ tree
    docs_dir = f"{pdir}/docs"
    if write and os.path.isdir(docs_dir):
        for d in sorted(glob.glob(f"{docs_dir}/**/", recursive=True), reverse=True):
            try: os.rmdir(d)
            except OSError: pass
        try: os.rmdir(docs_dir)
        except OSError: pass

    print(f"[{proj}] {'WROTE' if write else 'DRY-RUN'}: "
          f"{len(moves)} re-id+move, {len(retired)} retired, "
          f"{len(no_id)} no-id(skipped), {len(unknown)} unknown-bucket(skipped)")
    if no_id: print("  NO-ID:", [os.path.basename(x) for x in no_id])
    if unknown: print("  UNKNOWN BUCKET:", unknown)
    if unmapped:
        print("  UNMAPPED REFS (need manual / cross-project):")
        for tok, where in sorted(unmapped.items()):
            print(f"    {tok}: {where[:5]}")
    return {"moves":len(moves),"retired":len(retired),"no_id":len(no_id),
            "unknown":len(unknown),"unmapped":sorted(unmapped)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: migrate-doc-kinds.py <project> [--write]"); sys.exit(1)
    migrate(sys.argv[1], "--write" in sys.argv)
