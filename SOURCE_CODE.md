# Source and distribution information

The main KindleSpouse application is MIT-licensed. Existing third-party and component licenses are preserved; see `THIRD_PARTY_NOTICES.md`. No license in this repository grants rights to users' books, notes, photos or account credentials.

## KindleSpouse source

Repository: https://github.com/S1jinCheng/KindleSpouse

For a public binary release, provide the exact application tag or commit and its source archive alongside the installer. Preserve this file, `LICENSE`, `PRIVACY.md`, `THIRD_PARTY_NOTICES.md` and the generated dependency license directory. Build instructions are in `README.md` and the `scripts` directory.

## Components with their own source requirements

- KOReader v2026.07.1: https://github.com/koreader/koreader/tree/v2026.07.1 . The official runtime is unmodified; the Lua bridge is in this repository under `native/reader` with its AGPL-3.0 license. A full source checkout for the runtime includes its pinned submodules: `git clone --branch v2026.07.1 --recurse-submodules https://github.com/koreader/koreader.git`. Before publicly distributing binaries, make the corresponding source and build information available for the exact bundled runtime, including its native dependencies; a copy of its license alone is insufficient.
- Customisable Sleep Screen: commit `feb29ac02bbafeac32ccc9ceb471869c233ea253`, https://github.com/pxlflux/customisablesleepscreen.koplugin . The package includes the original archive and complete modified Lua source under `resources/native/tools/sleep-screen`. The preset source is under `native/sleep-cover`, and the separate KOReader plugin is under `native/companion/plugin`; these retain AGPL-3.0.
- KFX Input: commit `44db6b6ee8c0094a98c33770575a9070ddb90fda`, https://github.com/kluyg/calibre-kfx-input . Complete upstream source, its GPL-3.0 license and the separate worker are supplied under `resources/native/tools/kfx-input` and `native/PrepareReadable.py`.
- Notebook converter: commit `50da8be56403f04505ea08412d3dd0c57494350d`, https://github.com/sergazin/neo_scribe_to_pdf . The original archive, modified source, build information and GPL-3.0 text are supplied under `resources/native/tools/notebook-converter`. The inspector entry `native/InspectNotebook.mjs` retains GPL-3.0-only.
- Calibre is installed separately by the user and is not bundled.

Source archives in third-party tool folders are upstream public code, not user backups. Personal pairing archives, authentication databases, cloud snapshots and reading copies must never be included.
