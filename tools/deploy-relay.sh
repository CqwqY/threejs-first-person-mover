#!/usr/bin/env bash
# 把改过的服务端文件传到 relay 并重启（本机公钥没装到服务器，会提示输入密码）。
#
# 用法（在 Git Bash 里，任意目录都行）：
#   bash tools/deploy-relay.sh
#
# 为什么不写死在回复里的一条命令：路径里有中文，多行粘贴容易在 PowerShell/cmd 里被切碎。
# 这个脚本用自身位置定位项目，内容全 ASCII，怎么跑都不会因编码出错。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || exit 1

HOST="cai@100.127.187.92"
DEST="$HOST:/home/cai/fp-relay/"
# relay 需要的最小文件集（互相 import）：缺一个就可能整个 relay 起不来。
# ai.key.js 是密钥、auth.js 是鉴权，两个也一起带上，保证服务器与本机一致。
FILES="index.js npcworld.js policy.js ai-student.js ai.key.js auth.js"

echo "[deploy] project = $ROOT"
echo "[deploy] target  = $DEST"
echo "[deploy] 会提示输入 $HOST 的密码（本机没装公钥）"
echo

# 本地存在的文件拼成一条 scp 命令：一次连接传完，只需输一次密码
SEND=""
for f in $FILES; do
  if [ -f "server-remote/$f" ]; then
    SEND="$SEND server-remote/$f"
  else
    echo "[deploy] 跳过（本地没有）：$f"
  fi
done

if [ -n "$SEND" ]; then
  echo "[deploy] scp$SEND"
  # shellcheck disable=SC2086
  scp $SEND "$DEST" || { echo "[deploy] 传输失败（网络？密码？）"; exit 1; }
fi

echo
echo "[deploy] 重启 relay：pm2 restart fp-relay"
ssh "$HOST" "pm2 restart fp-relay" || { echo "[deploy] 重启失败：请 ssh 上去手动 pm2 restart fp-relay"; exit 1; }

echo
echo "[deploy] 最近日志（看一眼有没有启动报错）："
ssh "$HOST" "pm2 logs fp-relay --lines 15 --nostream" || true

echo
echo "[deploy] 完成。若日志里出现 Cannot find module，说明有文件没传齐，重跑本脚本即可。"
