<div align="center">

<img src="public/favicon.svg" width="76" alt="LightRead logo" />

# LightReadX · Free, open-source ebook reader for every format

**Turn your reading list into time well spent.**

EPUB / PDF / MOBI / AZW3 / TXT / Comics · Local-first · No ads

[中文](README.md) · English

[![Latest release](https://img.shields.io/github/v/release/Cantrarella/LightReadX?display_name=tag&sort=semver)](https://github.com/Cantrarella/LightReadX/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Cantrarella/LightReadX/total)](https://github.com/Cantrarella/LightReadX/releases)
[![License: AGPL v3+](https://img.shields.io/badge/License-AGPL_v3%2B-blue.svg)](LICENSE)

**[Download for desktop](https://github.com/Cantrarella/LightReadX/releases/latest)** · [Feedback](https://github.com/Cantrarella/LightReadX/issues)

Windows

Free, open source, no ads. Local reading needs no account or internet connection; your books, progress, and notes stay on your device by default.

> **About this project**: LightReadX is a fork of [yzfly/LightRead](https://github.com/yzfly/LightRead). The original author is **江树 / 云中江树 (Jiang Shu)**; many thanks to the upstream author for their open-source work. This fork focuses on **Windows desktop** builds and maintenance.

</div>

## LightRead at a glance

| | |
| --- | --- |
| What it is | An open-source, local-first ebook and comic reader: read books, papers, and comics in one app |
| Platforms | Windows 10 / 11 (64-bit) |
| Formats | EPUB, PDF, MOBI, AZW, AZW3, FB2, TXT, Markdown, HTML, DjVu, CBZ / CBR comics, plus plain text like code and logs |
| Cost & privacy | Free, AGPL-3.0 open source; no account required, network features are opt-in |
| Not supported | KFX and DRM-protected files |

## Comic reading

Built-in local comic reader for **CBZ / CBR** comics, plus online comic plugins.

- **Page mode**: simulated page-turn (with animation) or continuous scroll
- **Page view**: auto / single page / facing pages; "auto" switches by window width in real time — facing pages on wide windows, single page on narrow
- **Reading direction**: left-to-right / right-to-left (common for manga)
- **More**: auto trim margins, split double pages in portrait, bookmarks, ambient sound, fullscreen, zoom

Downloaded comics can be marked private, visible only to you.

## Local library

Drag files in and start reading, organized with a cover shelf, tags, booklists, and reading progress. Convert MOBI, AZW3, FB2, and TXT to EPUB in one click.

The "continue reading" card shows today's and this week's reading time, linking to full reading stats.

## Download & install

The latest desktop build is on GitHub Releases; installed apps prompt for updates in-app.

| Channel | Address | For |
| --- | --- | --- |
| GitHub Releases · Desktop | [github.com/Cantrarella/LightReadX/releases/latest](https://github.com/Cantrarella/LightReadX/releases/latest) | Windows |
| In-app update | Settings → About → Check for updates | Installed users |
| Build from source | See "For developers" below | Self-build or further development |

Choose the package for your device (`x.y.z` is the version):

| Device | Package |
| --- | --- |
| Windows 10 / 11 (64-bit) | `LightRead_x.y.z_x64-setup.exe` |

Each release ships a `SHA256SUMS` file you can use to verify downloads. After installing, drag your first book into LightRead to start.

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

## License

[GNU Affero General Public License v3.0 or later](LICENSE)

LightRead uses the AGPL-licensed MuPDF, so the project as a whole is released under AGPL-3.0-or-later. When distributing modified versions or providing modified versions as a network service, you must make the corresponding source code available under the license. This fork keeps the same license as upstream.

Acknowledgements: [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT) · [MuPDF](https://mupdf.com/) (AGPL-3.0-or-later) · [PDFium](https://pdfium.googlesource.com/pdfium/) (BSD-3-Clause) · [BabelDOC](https://github.com/funstory-ai/BabelDOC) · Chinese word lists from the [jieba](https://github.com/fxsjy/jieba) dictionary (MIT) and the [DeepSeek-R1](https://huggingface.co/deepseek-ai/DeepSeek-R1) tokenizer vocabulary (MIT)
