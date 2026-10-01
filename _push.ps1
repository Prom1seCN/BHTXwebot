$ErrorActionPreference = 'Continue'
Set-Location 'D:\projects\bhtxwebot'
Write-Output '=== ADD ==='
git add -A
Write-Output '=== STATUS ==='
git status --short
Write-Output '=== COMMIT ==='
git commit -m "feat: 同行雷达删除机制 + 热榜图片留档

- 删除：发帖人可自助申请删除第三方帖子（邮箱认证 + 勾选本人 + 选原因，24h 限 1 条）
- 留档：DeletedExternal 集合记录原帖内容与操作人，只增不改
- 黑名单：已删帖子不再被爬虫收录（含热榜回灌）
- 管理页：删除记录列表 + 一键恢复
- 热榜图片：hot-img 目录下载原图，按 URL 文件名去重
- 更新日志精简为三行"
Write-Output '=== PUSH ==='
git push origin HEAD 2>&1
Write-Output '=== RESULT ==='
git log --oneline -2
