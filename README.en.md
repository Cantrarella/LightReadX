<div align="center">

<img src="public/favicon.svg" width="76" alt="LightRead logo" />

# LightReadX · Free, open-source ebook reader for every format

**Turn your reading list into time well spent.**

EPUB / PDF / MOBI / AZW3 / TXT and more · Key-idea highlighting · Many reading modes · Text to speech · Bilingual PDF translation · Sync across devices

[中文](README.md) · English

[![Latest release](https://img.shields.io/github/v/release/Cantrarella/LightReadX?display_name=tag&sort=semver)](https://github.com/Cantrarella/LightReadX/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Cantrarella/LightReadX/total)](https://github.com/Cantrarella/LightReadX/releases)
[![License: AGPL v3+](https://img.shields.io/badge/License-AGPL_v3%2B-blue.svg)](LICENSE)

**[Download for desktop](https://github.com/Cantrarella/LightReadX/releases/latest)** · [Download the Android app](https://github.com/Cantrarella/LightReadX/releases?q=app-v&expanded=true) · [User guide (中文)](docs/manual/README.md) · [Feedback](https://github.com/Cantrarella/LightReadX/issues)

Windows · Android

Free, open source, no ads. Local reading needs no account or internet connection; your books, progress, and notes stay on your device by default.

> **About this project**: LightReadX is a fork of [yzfly/LightRead](https://github.com/yzfly/LightRead). The original author is **江树 / 云中江树 (Jiang Shu)**; many thanks to the upstream author for their open-source work. This fork focuses on **Windows desktop** and **Android app** builds and maintenance, keeping feature parity with upstream.

<img src="docs/screenshots/feature-library.png" width="1000" alt="LightRead local ebook library with cover grid, tags, custom booklists and reading progress" />

</div>

[PDF translation](#pdf-translation-keep-the-original-in-view) · [Guided reading](#guided-reading-let-the-key-ideas-stand-out) · [Booklists](#booklists-give-your-next-read-a-place) · [Reading stats](#reading-stats-see-your-reading-add-up) · [Listen & focus](#listen--focus-read-at-your-own-pace)

## LightRead at a glance

| | |
| --- | --- |
| What it is | An open-source, local-first ebook and PDF reader: read books, read papers, and listen to books in one app |
| Platforms | Windows 10 / 11 (64-bit), Android (arm64) |
| Formats | EPUB, PDF, MOBI, AZW, AZW3, FB2, TXT, Markdown, HTML, DjVu, CBZ / CBR comics, plus plain text like code and logs |
| Reading modes | Guided reading (key terms / key-sentence highlighting), typewriter, lyric, bionic reading, auto page-turn and steady scroll, follow-along TTS; night, eye-care, e-ink, large-text, and immersive scenes |
| Typography | Paged / chapter scroll / continuous scroll, single or double column; adjustable font size, line spacing, margins, font, and theme. App supports volume-key page turning and PDF reflow |
| Multi-device | Sync progress, notes, bookmarks, booklists, reading stats, and settings via a LightRead account or WebDAV; import/export your library archive |
| Cost & privacy | Free, AGPL-3.0 open source; no account required, network features are opt-in |
| Not supported | KFX and DRM-protected files |

## Mobile app

The Android app shares the same reading engine as the desktop app, with a phone-first UI: a bottom tab bar, a one-hand reachable reading toolbar, and bottom drawer panels.

| Library | Reading · Guided | Reading modes | Typography · Volume-key turn |
| --- | --- | --- | --- |
| <img src="docs/screenshots/app-library.png" width="200" alt="LightRead Android library: continue-reading card, daily reading time, tag filter, and cover shelf" /> | <img src="docs/screenshots/app-reader.png" width="200" alt="LightRead Android reader: guided reading highlights Chinese key terms offline" /> | <img src="docs/screenshots/app-reading-modes.png" width="200" alt="LightRead Android reading modes: guided, night, eye-care, e-ink, large text, immersive, and ambient sound" /> | <img src="docs/screenshots/app-typography.png" width="200" alt="LightRead Android typography: paged, chapter scroll, continuous scroll, progress, and volume-key page turning" /> |

| Listen | Book sources | Reading stats |
| --- | --- | --- |
| <img src="docs/screenshots/app-listen.png" width="200" alt="LightRead Android listening: sleep timer, voice, speed, and remaining time" /> | <img src="docs/screenshots/app-sources.png" width="200" alt="LightRead Android sources: unified search, Project Gutenberg, Internet Archive, arXiv, and private library" /> | <img src="docs/screenshots/app-stats.png" width="200" alt="LightRead Android stats: daily goal, streak, weekly goals, and reading-time trend" /> |

<sub>App screenshots are rendered from the app UI in a phone-sized (390 × 844) browser; sample books and stats are demo data. On a real device, listening uses online voices by default. [Screenshot reproduction notes](docs/screenshots/README.md)</sub>

## A local library that keeps your books together

Drag files in and start reading. Organize your collection with a **cover shelf, tags, booklists, and reading progress**; papers have their own entry point, so reading and research each have a home.

Supports **EPUB, PDF, MOBI, AZW / AZW3, TXT, Markdown**, plus FB2, CBZ / CBR comics, DjVu, HTML, and plain text such as code and logs. MOBI, AZW3, FB2, and TXT can also be converted to EPUB in one click. KFX and DRM-protected files are not supported.

## PDF translation, keep the original in view

**Original on the left, translation on the right.** Word-level translation and page-by-page layout comparison, with annotations as you read. On desktop you can also use **BabelDOC** to produce Chinese or bilingual PDFs.

<img src="docs/screenshots/feature-pdf-translation.png" width="1000" alt="LightRead PDF paper translation: English original on the left and Chinese translation on the right, matched by layout" />

Want to go deeper? The desktop **Paper Agent and Ten Questions** help you interrogate arguments, methods, and evidence; your answers are kept separately. [Read the paper-reading guide →](docs/paper-reading.md)

<details>
<summary>Translation & AI prerequisites</summary>

Page-by-page and word-level translation use the AI service you configure. BabelDOC is desktop-only, requires installing a runtime environment and model, and needs a personal model service; provider charges may apply. The Paper Agent requires installing and configuring one of Pi, Codex, or Claude Code. Scanned PDFs can be displayed, but text selection and analysis require a text layer; OCR is not currently built in.

</details>

## Guided reading, let the key ideas stand out

**The basic tier highlights words and key terms offline; the smart tier uses AI to surface key sentences, concepts, and notes.** Catch the thread when reading long texts, and revisit the essentials with chapter summaries, a book-wide outline, and speed reading.

<img src="docs/screenshots/feature-dianjing.png" width="1000" alt="LightRead guided reading (basic): key terms are colored in the original text while keeping the full text and layout" />

The image shows the basic tier. The smart tier calls AI services after your consent. It works for reflowable books such as EPUB and TXT, and does not yet support PDF or fixed-layout books. [Learn about guided reading →](docs/manual/05-点睛阅读.md)

## Booklists, give your next read a place

**Finished, reading, or still looking — put them all in one list.** Supports to-find lists, auto-matching into your library, recommended lists, and export/sharing, so your reading plan has a place to land.

<img src="docs/screenshots/feature-booklists.png" width="1000" alt="LightRead booklists: classics, textbooks, and AI & agents, switched via tabs" />

## Reading stats, see your reading add up

**How long you read today, what you read this week, which book kept you company longest.** Daily goals, streaks, weekly/monthly/yearly trends, and a reading calendar turn scattered reading time into a habit.

<img src="docs/screenshots/feature-reading-stats.png" width="1000" alt="LightRead reading stats: daily goal, streak, weekly time trend, milestones, and per-book progress" />

## Listen & focus, read at your own pace

**Rest your eyes and listen, or switch up how you read when you want to focus.** Listening supports speed control, a sleep timer, and resume where you left off; there are also typewriter, lyric, auto page-turn, ambient sound, and night, eye-care, and large-text scenes.

| Listen: have books read to you | Reading modes: read at your own pace |
| --- | --- |
| [![LightRead listening panel: voice, speed, sleep timer, and playback controls](docs/screenshots/feature-listen.png)](docs/screenshots/feature-listen.png) | [![LightRead reading modes: guided, night, eye-care, e-ink, large text, immersive, and follow-along settings](docs/screenshots/feature-reading-modes.png)](docs/screenshots/feature-reading-modes.png) |

The desktop app supports online voices, downloadable offline models, and system voices; the app uses online or system voices. [Listening & ambient sound →](docs/manual/03-声音.md)

## Public book sources, from "what to read" to reading

**Search books, find papers, and browse booklists in one place.** Connect to Project Gutenberg, Internet Archive, arXiv, OPDS / Calibre, or your own library.

<img src="docs/screenshots/feature-discovery.png" width="1000" alt="LightRead public book sources and recommended booklists: unified search, curated lists, OPDS, and private library entry" />

Recommended booklists are enabled in Settings → Features. Availability, download conditions, and licensing of each source are governed by the source. [Self-hosted library guide →](docs/self-hosted-library.md)

## Continue reading on another device

| What you want | What LightRead offers |
| --- | --- |
| Continue on phone and computer | LightRead account syncs progress, notes, bookmarks, booklists, and reading stats; book files are imported separately |
| Sync books too | WebDAV can optionally sync book files, connecting to your own drive or NAS |
| Send a snippet or a file | Transfer supports account, WebDAV, and temporary pickup-code channels |
| Back up or move | Import / export a `.okf.zip` library archive; desktop can customize the library location |
| Keep thoughts in the book | Highlight, annotate, bookmark, in-book search, and return to where you left off |

Local data stays on your device by default. Online sources, voices, AI, and sync connect as used; remote AI will receive the relevant text. The library archive does not include app settings, credentials, or the Agent working directory. [Sync & backup notes →](docs/manual/04-使用说明.md#8-多端同步)

## Download & install

Desktop and Android apps are released separately; the latest of each is on GitHub Releases. Installed apps prompt for updates in-app.

| Channel | Address | For |
| --- | --- | --- |
| GitHub Releases · Desktop | [github.com/Cantrarella/LightReadX/releases/latest](https://github.com/Cantrarella/LightReadX/releases/latest) | Windows |
| GitHub Releases · Android | [Releases starting with `app-v`](https://github.com/Cantrarella/LightReadX/releases?q=app-v&expanded=true) | Android phones & tablets |
| In-app update | Settings → About → Check for updates | Installed users |
| Build from source | See "For developers" below | Self-build or further development |

Choose the package for your device (`x.y.z` is the version):

| Device | Package |
| --- | --- |
| Windows 10 / 11 (64-bit) | `LightRead_x.y.z_x64-setup.exe` |
| Android 7.0+ (arm64) | `LightRead_app-vx.y.z_android_arm64.apk` |

Each release ships a `SHA256SUMS` file you can use to verify downloads. After installing, drag your first book into LightRead to start. [Full install & upgrade guide](docs/installation.md) · [Three-minute start](docs/manual/README.md#三分钟上手)

<a id="android-experimental"></a>
**Android note:** The app is currently experimental (package `com.cantrarella.lightreadx`). A new build with the same signature upgrades in place. Historical builds may use a different signature; if you hit an install conflict, keep the old app, export and verify a backup outside the app directory, then follow the [migration steps](docs/installation.md#android实验性).

<details>
<summary>For developers: run from source</summary>

The desktop app needs Node.js, Rust, and the Tauri 2 build dependencies for your platform.

```bash
git clone https://github.com/Cantrarella/LightReadX.git
cd LightReadX
npm install
npm run dev          # web development
npm run tauri dev    # desktop development (Windows)
```

Build with `npm run build` (frontend) or `npm run tauri build` (desktop). Stack: Vue 3, TypeScript, Tauri 2 / Rust, foliate-js, MuPDF / PDFium. See [CLAUDE.md](CLAUDE.md) for development conventions.

</details>

## Help make LightRead better

If you like the project, please **[star the upstream yzfly/LightRead](https://github.com/yzfly/LightRead)**; you're also welcome to [file suggestions](https://github.com/Cantrarella/LightReadX/issues) or submit PRs to this fork.

Author: **江树 / 云中江树 (Jiang Shu)** (original author of [yzfly/LightRead](https://github.com/yzfly/LightRead)) · WeChat: **1796060717** (note `LightRead`) · WeChat Official Account: **云中江树**

<sub>This page shows real app screenshots; the library, reading stats, and PDF translations use demo data, and the sample books and covers are made for this project and not bundled with the app. [Screenshot reproduction notes](docs/screenshots/README.md)</sub>

## License

[GNU Affero General Public License v3.0 or later](LICENSE)

LightRead uses the AGPL-licensed MuPDF, so the project as a whole is released under AGPL-3.0-or-later. When distributing modified versions or providing modified versions as a network service, you must make the corresponding source code available under the license. This fork keeps the same license as upstream.

Acknowledgements: [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT) · [MuPDF](https://mupdf.com/) (AGPL-3.0-or-later) · [PDFium](https://pdfium.googlesource.com/pdfium/) (BSD-3-Clause) · [BabelDOC](https://github.com/funstory-ai/BabelDOC) · Chinese word lists from the [jieba](https://github.com/fxsjy/jieba) dictionary (MIT) and the [DeepSeek-R1](https://huggingface.co/deepseek-ai/DeepSeek-R1) tokenizer vocabulary (MIT)
