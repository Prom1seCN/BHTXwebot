#!/usr/bin/env bash
# bhtxweb MongoDB 备份：每 12 小时一次（cron 4:30 / 16:30），保留 14 天
set -euo pipefail
umask 077   # 备份含全库 PII：产物与目录仅属主可读
TS=$(date +%F_%H%M)
DIR=/home/ubuntu/backups/mongo
mkdir -p "$DIR"
chmod 700 "$DIR"
FILE="$DIR/bhtxweb_$TS.gz"

docker exec bhtx-mongo mongodump --quiet --db bhtxweb --archive --gzip > "$FILE"

# 完整性校验：还原到一次性验证库并计数，随后删除（set -e 保证失败即中止）
docker exec -i bhtx-mongo mongorestore --quiet --gzip --archive \
  --nsFrom='bhtxweb.*' --nsTo='bhtxverify.*' --drop < "$FILE" >/dev/null
n=$(docker exec bhtx-mongo mongosh --quiet bhtxverify --eval 'db.trips.countDocuments({})')
docker exec bhtx-mongo mongosh --quiet --eval 'db.getSiblingDB("bhtxverify").dropDatabase()' >/dev/null

# 清理 14 天前的旧备份
find "$DIR" -name 'bhtxweb_*.gz' -mtime +14 -delete

sz=$(stat -c%s "$FILE")
echo "[$(date '+%F %T')] OK $FILE ${sz}B restore-check trips=$n"
