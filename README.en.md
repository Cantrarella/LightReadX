<div align="center">

<img src="public/favicon.svg" width="76" alt="LightRead logo" />

# LightReadX

**Free, open-source ebook and comic reader (Windows desktop)**

[![Latest release](https://img.shields.io/github/v/release/Cantrarella/LightReadX?display_name=tag&sort=semver)](https://github.com/Cantrarella/LightReadX/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Cantrarella/LightReadX/total)](https://github.com/Cantrarella/LightReadX/releases)
[![License: AGPL v3+](https://img.shields.io/badge/License-AGPL_v3%2B-blue.svg)](LICENSE)

**[Download for desktop](https://github.com/Cantrarella/LightReadX/releases/latest)** · [Feedback](https://github.com/Cantrarella/LightReadX/issues)

[中文](README.md) · [English](README.en.md)

</div>

> This project is a fork of [yzfly/LightRead](https://github.com/yzfly/LightRead), with thanks to the original author **江树 / 云中江树 (Jiang Shu)** for their open-source work.

## Comic plugin system (new)

- Built-in Breeze-compatible plugin runtime supporting online comic source plugins
- Comic source management, search, detail, online reading, and chapter download into the library
- Plugin store and discovery page

## Comic reader

- Self-styled online reader with reading cache and cleanup
- **Page mode**: simulated page-turn (with animation) / continuous scroll
- **Page view**: auto / single page / facing pages; "auto" switches between facing pages and single page by window width in real time
- Reading direction (LTR/RTL), auto trim margins, split double pages in portrait
- Bookmarks, ambient sound, fullscreen, zoom

## Download center

- Resumable downloads, pause/resume, automatic retry on failure
- Batch download, queue progress, completion notification
- Duplicate download detection, library file scan import
- Downloaded comics can be marked private

## Platform & release

- Desktop builds Windows only (Mac/Linux removed)
- App identifier unified to com.cantrarella.lightreadx
- Update source points to this repo; GitCode mirror and GitHub Pages homepage removed

## Data migration (no data loss on upgrade)

- Legacy data directory auto-migrated: library, covers, and downloaded comics are preserved
- Login state (cookies) preserved through migration

## UI consistency

- Source / reading stats / settings / transfer title bars aligned to the same top spacing
- Comics "continue reading" card aligned with the library, with today/this-week reading time
- Logo repositioned to align, theme switching fixed

## Other

- Removed paper module and paper agent
- Comic view styles migrated to design tokens

---

## Open-source notice

This project is built on [yzfly/LightRead](https://github.com/yzfly/LightRead) and released under **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. When distributing modified versions or providing modified versions as a network service, you must provide the corresponding source code under the license. This fork keeps the same license as upstream.

Acknowledgements: [foliate-js](https://github.com/johnfactotum/foliate-js) · [MuPDF](https://mupdf.com/) · [PDFium](https://pdfium.googlesource.com/pdfium/) · [BabelDOC](https://github.com/funstory-ai/BabelDOC) · [jieba](https://github.com/fxsjy/jieba) dictionary and [DeepSeek-R1](https://huggingface.co/deepseek-ai/DeepSeek-R1) tokenizer vocabulary
