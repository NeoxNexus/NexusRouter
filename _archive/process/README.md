# Process Archive Guide

This directory stores historical process artifacts moved out of the project root.
Keep runtime/build/test code outside this archive.

## Directory Purpose

- `reviews/`
  - Code review outputs and post-phase review notes.
  - Example: `CODE_REVIEW_PHASE2.md`

- `manifests/`
  - Development principles, team conventions, and workflow policies.
  - Example: `DEVELOPMENT_MANIFESTO.md`

- `specs/`
  - Historical specifications and design requirement snapshots.
  - Example: `SPEC.md`

- `trackers/`
  - Phase task trackers and execution checklists.
  - Example: `TASK_TRACKER.md`

- `walkthroughs/`
  - Phase delivery walkthroughs, implementation retrospectives, and execution logs.
  - Examples: `WALKTHROUGH_PHASE1.md`, `WALKTHROUGH_PHASE2.md`

- `chronicles/`
  - Narrative collaboration logs and historical retrospectives.
  - Example: `COLLABORATION_CHRONICLES.md`

## What Should Be Archived Here

- Documents that are no longer needed in root navigation.
- Historical process files that do not affect build/test/runtime behavior.
- Files kept mainly for traceability, audit, and context recall.

## Retrieval Tips

- Find by keyword across all process archives:
  - `rg -n "keyword" _archive/process`

- Find all files under one theme:
  - `find _archive/process/specs -type f | sort`
  - `find _archive/process/walkthroughs -type f | sort`

- Locate a specific phase artifact:
  - `rg -n "PHASE2|Phase 2" _archive/process`

- Quick filename search:
  - `rg --files _archive/process | rg "REVIEW|SPEC|WALKTHROUGH|MANIFESTO|TRACKER|CHRONICLE"`

## Naming Suggestions

- Keep original filenames when first archived (preserves references in old notes).
- For new files, prefer:
  - `CODE_REVIEW_PHASE<N>.md`
  - `WALKTHROUGH_PHASE<N>.md`
  - `<TOPIC>_SPEC_<YYYY-MM-DD>.md` (optional for new specs)
