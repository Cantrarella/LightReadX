<div align="center">

<img src="public/favicon.svg" width="76" alt="LightRead 轻阅图标" />

# LightReadX

**开源免费的全格式电子书与漫画阅读器（Windows 桌面版）**

[![Latest release](https://img.shields.io/github/v/release/Cantrarella/LightReadX?display_name=tag&sort=semver)](https://github.com/Cantrarella/LightReadX/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Cantrarella/LightReadX/total)](https://github.com/Cantrarella/LightReadX/releases)
[![License: AGPL v3+](https://img.shields.io/badge/License-AGPL_v3%2B-blue.svg)](LICENSE)

**[下载桌面版](https://github.com/Cantrarella/LightReadX/releases/latest)** · [反馈建议](https://github.com/Cantrarella/LightReadX/issues)

[中文](README.md) · [English](README.en.md)

</div>

> 本项目 fork 自 [yzfly/LightRead](https://github.com/yzfly/LightRead)，向原作者 **江树 / 云中江树** 的开源工作致谢。

## 漫画插件系统（全新）

- 内置 Breeze 兼容插件运行时，支持在线漫画源插件
- 漫画源管理、搜索、详情、在线阅读、章节下载入库
- 插件商店与发现页

## 漫画阅读器

- 自带样式的在线阅读器，支持阅读缓存与清理
- **翻页方式**：仿真翻页（带动画）/ 连续滚动
- **页面视图**：自动 / 单页 / 对页，「自动」档按窗口宽度实时切换双页/单页
- 翻页方向（LTR/RTL）、自动裁白边、竖屏自动拆分双页
- 书签、背景音、全屏、缩放

## 下载中心

- 断点续传、暂停恢复、失败自动重试
- 批量下载、队列总进度、完成通知
- 重复下载查重、书库散文件扫描导入
- 下载后漫画可设为私密

## 平台与发布

- 桌面版仅编译 Windows（移除 Mac/Linux）
- 应用标识统一为 com.cantrarella.lightreadx
- 更新源指向本仓库，移除 GitCode 镜像与 GitHub Pages 主页

## 数据迁移（升级不丢数据）

- 旧数据目录自动迁移，书库、封面、下载漫画不丢
- 登录态（Cookie）随迁移保留

## 界面统一

- 书源 / 阅读记录 / 设置 / 传输标题栏离顶距离统一
- 漫画页「最近阅读」卡片对齐藏书页，补今日/本周阅读时长
- logo 下移对齐、主题切换修正

## 其它

- 移除论文模块与论文 Agent
- 漫画视图样式改用设计令牌

---

## 开源说明

本项目基于 [yzfly/LightRead](https://github.com/yzfly/LightRead) 二次开发，遵循 **GNU Affero General Public License v3.0 or later（AGPL-3.0-or-later）** 开源协议。分发修改版或通过网络向用户提供修改版服务时，须依照协议提供对应源代码。本 fork 与上游保持同一协议。

致谢：[foliate-js](https://github.com/johnfactotum/foliate-js) · [MuPDF](https://mupdf.com/) · [PDFium](https://pdfium.googlesource.com/pdfium/) · [BabelDOC](https://github.com/funstory-ai/BabelDOC) · [jieba](https://github.com/fxsjy/jieba) 词典与 [DeepSeek-R1](https://huggingface.co/deepseek-ai/DeepSeek-R1) 分词器词表
