/**
 * 项目主页与文档地址。本项目 (LightReadX) 是 yzfly/LightRead 的 fork，
 * 面向用户的说明、手册、下载入口一律指向本仓库的 GitHub 页面。
 * 应用内《使用手册》仍打包离线可看，这里只决定「去网页看」时打开哪一页。
 */
export const SITE_URL = 'https://github.com/Cantrarella/LightReadX/'
export const SITE_MANUAL_URL = `${SITE_URL}blob/main/docs/manual/`
export const SITE_DOWNLOAD_SECTION = `${SITE_URL}releases/latest`

const REPO_BLOB = 'https://github.com/Cantrarella/LightReadX/blob/main/'

/**
 * 仓库内路径 (可带 #锚点) 对应的网页地址: 手册目录去 GitHub 的 docs/manual，
 * 项目 README 去仓库首页 (下载 / 安装类锚点落到 releases)，其余文档去 GitHub 对应文件。
 */
export function siteUrlForRepoPath(repoPath: string): string {
  const [path, hash] = repoPath.replace(/^\/+/, '').split('#')
  if (path === 'README.md' || path === 'README.en.md') {
    let anchor = hash ?? ''
    try { anchor = decodeURIComponent(anchor) } catch { /* 保持原样 */ }
    return /下载|安装|android|download|install/i.test(anchor) ? SITE_DOWNLOAD_SECTION : SITE_URL
  }
  return REPO_BLOB + path + (hash ? `#${hash}` : '')
}
