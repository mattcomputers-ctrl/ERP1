# Reference material (local only — not committed)

This folder holds the legacy **Mar-Kov CMS** vendor documentation used to drive
the rebuild:

- `CMS User Guide - Mar-Kov.pdf` (2018) — the functional specification
- `Release Notes 7.16–7.22` — newer features/changes

These files are **vendor-confidential** ("shall not be reproduced or disclosed
to any third party") and are therefore **git-ignored** — they are intentionally
not pushed to GitHub. Keep your local copies in this folder; the tooling reads
them from here on demand.

PDF text is extracted with `pdftotext` (poppler / Git-for-Windows) when needed;
extracts land in `docs/discovery/` which is also git-ignored.
