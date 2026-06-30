#!/usr/bin/env python3
"""Finish the legacy->tool migration deterministically (workers died on provider outage).
For each remaining source file: map owner+kind, wrap body under ## Content (demote inner
## to ###), create via `wiki create` (mints id), delete source on success."""
import os, re, subprocess, sys, glob

VAULT = os.path.expanduser("~/Knowledge")
TOOL = "/Users/tothemoon/Dev/code-forge/wiki"
DRY = "--dry-run" in sys.argv

def fm_field(txt, name):
    m = re.search(rf'^{name}:\s*(.+)$', txt, re.M)
    return m.group(1).strip().strip('"\'') if m else ""

def strip_fm(txt):
    return re.sub(r'^---.*?---\s*', '', txt, count=1, flags=re.S)

def wrap_body(body):
    # demote any top-level ## heading to ### so the only ## section is our Content wrapper
    demoted = re.sub(r'(?m)^## ', '### ', body)
    # also demote a leading H1 (# Title) to ### to avoid duplicate title noise
    demoted = re.sub(r'(?m)^# ', '### ', demoted)
    return "## Content\n\n" + demoted.strip() + "\n"

# ---- owner + kind resolution -------------------------------------------------
def resolve(path):
    rel = path.replace(VAULT + "/", "")
    txt = open(path, encoding="utf-8", errors="ignore").read()
    typ = fm_field(txt, "type")
    topic = rel.split("/")[1] if rel.startswith("research/") and "/" in rel[len("research/"):] else ""
    base = os.path.basename(path)

    # wiki/entities/* -> concepts (cross-cutting tech reference)
    if rel.startswith("wiki/entities/"):
        return "concepts", "architecture"
    # wiki/syntheses/* -> named project
    if rel.startswith("wiki/syntheses/"):
        if base.startswith("rift"): return "rift", "research"
        if base.startswith("bayland-portfolio-v1"): return "bayland-portfolio-v1", "research"
        if base.startswith("wiki-forge"): return "wiki-v2", "research"
        return None, None
    if rel == "wiki/improvements-roadmap.md":
        return "wiki-v2", "research"
    if rel.startswith("wiki/projects/"):
        owner = rel.split("/")[2]
        kindmap = {"prd":"prd","decisions":"decision","domain-language":"architecture"}
        k = "architecture" if ("architecture" in rel or "domain-language" in base or base=="decisions.md") else ("prd" if "prd" in base or "/prds/" in rel else "research")
        return owner, k

    # research/<topic>/...
    t = topic.lower()
    def k_for(txt):
        if typ in ("research-topic","synthesis") or True:
            # decide by content cues
            if re.search(r'domain language|glossary|ubiquitous', txt[:400], re.I): return "architecture"
            if re.search(r'\brunbook\b|checklist|step-by-step', txt[:400], re.I): return "runbooks"
            return "research"
    owner = None
    if t.startswith("bayland-platform") or t=="bayland-platform": owner="bayland-platform"
    elif t.startswith("observability") or t=="grafana-otel-migration": owner="bayland-platform"
    elif t in ("chat-agent-performance","production-readiness","single-device-auth-security","staging-auth-infra","wavebasis-integration","audit-logs-investigation-ui","audit-diff-summary-storage","parity"): owner="bayland-platform"
    elif base.startswith("bayland-elliott-suite"): owner="bayland-elliott-suite"
    elif base.startswith("bayland-portfolio-v1"): owner="bayland-portfolio-v1"
    elif t in ("terminal-state-authority",): owner="bayland-platform"
    elif t == "security": owner="concepts"  # cross-project secrets/1Password/machine-hardening
    return owner, k_for(txt)

def is_stub(txt):
    body = strip_fm(txt)
    words = len(re.sub(r'[#>*`\-\[\]|]', ' ', body).split())
    return words < 60

# ---- run ---------------------------------------------------------------------
sources = []
for f in glob.glob(f"{VAULT}/research/**/*.md", recursive=True) + glob.glob(f"{VAULT}/wiki/**/*.md", recursive=True):
    if os.path.basename(f) == "index.md": continue
    sources.append(f)

done=0; stubs=0; skipped=[]
for f in sorted(sources):
    txt = open(f, encoding="utf-8", errors="ignore").read()
    owner, kind = resolve(f)
    if owner is None:
        skipped.append((f,"no-owner")); continue
    if is_stub(txt) and os.path.basename(f).startswith("_overview"):
        if not DRY: os.remove(f)
        stubs+=1; continue
    title = fm_field(txt,"title") or os.path.basename(f).replace(".md","").replace("-"," ").title()
    summary = fm_field(txt,"summary") or f"Migrated legacy {kind} doc: {title}."
    summary = summary[:200]
    body = wrap_body(strip_fm(txt))
    if DRY:
        print(f"{owner:22} {kind:12} <- {f.replace(VAULT+'/','')}")
        done+=1; continue
    p = subprocess.run(["bun","src/cli.ts","create",kind,f"--project={owner}",
                        f"--title={title}",f"--summary={summary}","--body=-"],
                       cwd=TOOL, input=body, capture_output=True, text=True,
                       env={**os.environ,"KNOWLEDGE_VAULT_ROOT":VAULT})
    if p.returncode==0:
        os.remove(f); done+=1
    else:
        skipped.append((f, (p.stderr or p.stdout).strip().split("\n")[-1][:120]))

print(f"\n{'DRY ' if DRY else ''}migrated: {done} | stubs removed: {stubs} | skipped: {len(skipped)}")
for f,why in skipped[:40]: print(f"  SKIP {f.replace(VAULT+'/','')}: {why}")
