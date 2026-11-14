<div align="center">

<img src="public/favicon.svg" width="76" alt="LightRead 轻阅图标" />

# LightReadX · 开源免费的全格式电子书阅读器

**让想读的书，变成读进去的书。**

EPUB / PDF / MOBI / AZW3 / TXT / 漫画全格式 · 本地优先 · 无广告

[中文](README.md) · [English](README.en.md)

[![Latest release](https://img.shields.io/github/v/release/Cantrarella/LightReadX?display_name=tag&sort=semver)](https://github.com/Cantrarella/LightReadX/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Cantrarella/LightReadX/total)](https://github.com/Cantrarella/LightReadX/releases)
[![License: AGPL v3+](https://img.shields.io/badge/License-AGPL_v3%2B-blue.svg)](LICENSE)

**[下载桌面版](https://github.com/Cantrarella/LightReadX/releases/latest)** · [反馈建议](https://github.com/Cantrarella/LightReadX/issues)

Windows

免费、开源、无广告。本地阅读无需账号、无需联网；藏书、进度与笔记默认留在自己的设备上。

> **关于本项目**：LightReadX 是 [yzfly/LightRead](https://github.com/yzfly/LightRead) 的一个 fork。原作者为 **江树 / 云中江树**，在此向原作者的开源工作致谢。本 fork 面向 **Windows 桌面版** 的维护与自用构建。

</div>

## 一眼看懂轻阅

| | |
| --- | --- |
| 是什么 | 开源、本地优先的电子书与漫画阅读器，读书、读论文、看漫画都在一个应用里 |
| 支持设备 | Windows 10 / 11（64 位） |
| 支持格式 | EPUB、PDF、MOBI、AZW、AZW3、FB2、TXT、Markdown、HTML、DjVu、CBZ / CBR 漫画，以及代码、日志等纯文本文件 |
| 费用与隐私 | 免费，AGPL-3.0 开源；不需要账号即可使用，联网功能按需开启 |
| 不支持 | KFX 与 DRM 加密文件 |

## 漫画阅读

内置漫画本地阅读器，支持 **CBZ / CBR** 漫画，也支持在线漫画插件抓取阅读。

- **翻页方式**：仿真翻页（带翻页动画）或连续滚动
- **页面视图**：自动 / 单页 / 对页；「自动」档按窗口宽度实时切换——宽窗口双页并排，窄窗口单页
- **翻页方向**：从左到右 / 从右到左（日漫常见）
- **其它**：自动裁白边、竖屏自动拆分双页、书签、背景音、全屏、缩放

下载后的漫画可设为私密，仅自己可见。

## 本地书库

拖入文件即可开读，用封面书架、标签、书单和阅读进度整理藏书。支持一键把 MOBI、AZW3、FB2、TXT 转成 EPUB。

「最近阅读」卡片实时显示今日 / 本周阅读时长，点进去可查看完整阅读记录。

## 下载与安装

桌面版最新版在 GitHub Releases，已安装的应用会在应用内提示更新。

| 渠道 | 地址 | 适合 |
| --- | --- | --- |
| GitHub Releases · 桌面版 | [github.com/Cantrarella/LightReadX/releases/latest](https://github.com/Cantrarella/LightReadX/releases/latest) | Windows |
| 应用内更新 | 设置 → 关于 → 检查更新 | 已安装用户 |
| 源码构建 | 见下方「开发者：从源码运行」 | 自行构建或二次开发 |

按设备选择安装包（`x.y.z` 为版本号）：

| 设备 | 安装包 |
| --- | --- |
| Windows 10 / 11（64 位） | `LightRead_x.y.z_x64-setup.exe` |

每个版本附带 `SHA256SUMS`，可核对下载文件是否完整。安装后，把第一本书拖进轻阅即可开始。

<details>
<summary>开发者：从源码运行</summary>

桌面版需要 Node.js、Rust 与对应平台的 Tauri 2 构建依赖。

```bash
git clone https://github.com/Cantrarella/LightReadX.git
cd LightReadX
npm install
npm run dev          # 网页开发
npm run tauri dev    # 桌面开发（Windows）
```

构建：`npm run build`（前端）或 `npm run tauri build`（桌面）。技术栈：Vue 3、TypeScript、Tauri 2 / Rust、foliate-js、MuPDF / PDFium。开发约定见 [CLAUDE.md](CLAUDE.md)。

</details>

## 开源协议

[GNU Affero General Public License v3.0 or later](LICENSE)

LightRead 使用 AGPL 授权的 MuPDF，因此项目整体以 AGPL-3.0-or-later 发布。分发修改版或通过网络向用户提供修改版服务时，须依照协议提供对应源代码。本 fork 与上游保持同一协议。

致谢：[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT) · [MuPDF](https://mupdf.com/) (AGPL-3.0-or-later) · [PDFium](https://pdfium.googlesource.com/pdfium/) (BSD-3-Clause) · [BabelDOC](https://github.com/funstory-ai/BabelDOC) · 中文词表取自 [jieba](https://github.com/fxsjy/jieba) 词典 (MIT) 与 [DeepSeek-R1](https://huggingface.co/deepseek-ai/DeepSeek-R1) 分词器词表 (MIT)
