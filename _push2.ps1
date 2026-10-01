Set-Location 'D:\projects\bhtxwebot'
git add -A
Write-Output '=== STATUS ==='
git status --short
git -c user.name=Prom1seCN -c user.email=208032284+Prom1seCN@users.noreply.github.com commit -F .git/COMMIT_MSG_FILE
Write-Output '=== PUSH ==='
git push origin HEAD 2>&1
Write-Output '=== LOG ==='
git log --oneline -2
