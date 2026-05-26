---
source: wiki-v2
---
# Admin: vault

Use this for bootstrap and health operations.

- `init` creates or refreshes vault scaffolding and repo orientation.
- `doctor` reports missing files, schema drift, and unsafe state.
- `sync` refreshes generated views from source artifacts.
- `bless` records that the current generated output is expected.

Run admin commands only when requested or when the active phase packet/status requires repair. Never create vault folders by hand.
