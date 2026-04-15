# Mantle Launch Benchmarks

This directory defines the replayable launch benchmark suite for the three public Mantle workflows:

- `selection -> rewrite`
- `downloads -> organize + rollback`
- `context -> todo`

## Layout

- `fixtures/selection/`: stable text snippets used by rewrite cases
- `fixtures/downloads-sandbox/default/`: sandbox files copied into a temporary `Downloads/` folder for organize and rollback cases
- `fixtures/context/`: fixed environment snapshots for context-driven todo generation
- `prompts/`: prompt packs and expected checks for each workflow
- `results/`: generated benchmark reports and per-case artifacts
- `scripts/`: live rehearsal runbook and record templates

## Commands

Run the full launch benchmark with L2 quality evaluation:

```bash
cd agent-core
npm run bench:launch
```

Run the benchmark in CI mode and fail on hard-gate regressions:

```bash
cd agent-core
npm run bench:launch:ci
```

Run the replay suite via the Node test runner:

```bash
cd agent-core
npm run test:e2e:launch
```

## Output

Each benchmark run writes a timestamped result bundle under `results/<timestamp>/`, including:

- `summary.json`
- `summary.md`
- `workflow-a-selection.json`
- `workflow-b-downloads.json`
- `workflow-c-context.json`
- `diagnostics-before.json`
- `diagnostics-after.json`
- `cases/<case-id>/...`
- `traces/<case-id>.json`

The replay suite is the stable regression layer. The live rehearsal runbook in `scripts/` is still required before a public release recording.
