# -*- coding: utf-8 -*-
"""BHTXwebot 部署工具（开发用）
用法：python tools/deploy.py <stage> [extra_args]
stage: recon | upload | start | nginx-check | nginx-cut | verify | stop-old
认证：SSH 私钥（~/.ssh/id_ed25519）。服务器已于 2026-09-14 关闭密码登录，勿再传密码。
"""
import sys
import os
import time
import paramiko

# Windows 控制台默认 GBK：脚本里的 ✅/❌ 与中文输出会抛 UnicodeEncodeError
# （upload 阶段 24 个文件已传完，最后那句 ✅ 打印反而让整条命令看起来像失败）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST, USER = "49.232.135.134", "ubuntu"
STAGES = {"recon", "upload", "start", "nginx-check", "nginx-cut", "verify", "stop-old"}
_args = sys.argv[1:]
if _args and _args[0] not in STAGES and len(_args) > 1 and _args[1] in STAGES:
    # 兼容旧调用 `deploy.py <密码> <stage>`：提示后按旧签名移位解析
    print("提示：已改密钥认证，不再需要密码参数（该行内容请忽略/清除）")
    _args = _args[1:]
STAGE = _args[0] if _args else "recon"
EXTRA = _args[1:]
LOCAL = r"D:\Projects\BHTXwebot"
REMOTE = "/home/ubuntu/bhtxweb"  # 服务器部署目录沿用旧名，未随仓库改名迁移


def load_key():
    # 本机的 ~/.ssh/id_ed25519 是 Windows ssh-keygen 生成的：注释为 GBK 且私钥段恰好
    # 8 字节对齐、无填充——OpenSSH/cryptography 认，paramiko 的 _unpad_openssh 判
    # "Invalid key"（paramiko 已知短板）。因此直接解析失败时，用 cryptography 加载后
    # 重新序列化成带规范填充的 OpenSSH 格式再喂 paramiko（私钥本体不变）。
    import io
    path = os.path.expanduser("~/.ssh/id_ed25519")
    if not os.path.isfile(path):
        sys.exit("找不到 SSH 私钥（~/.ssh/id_ed25519），无法连接服务器")
    try:
        return paramiko.Ed25519Key.from_private_key_file(path)
    except paramiko.SSHException:
        from cryptography.hazmat.primitives.serialization import (
            load_ssh_private_key, Encoding, PrivateFormat, NoEncryption)
        ck = load_ssh_private_key(open(path, "rb").read(), None)
        pem = ck.private_bytes(Encoding.PEM, PrivateFormat.OpenSSH, NoEncryption())
        return paramiko.Ed25519Key.from_private_key(io.StringIO(pem.decode()))


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=load_key(),
              timeout=15, banner_timeout=15, allow_agent=False, look_for_keys=False)
    return c


NVM_PATH = 'export PATH="$(ls -d $HOME/.nvm/versions/node/*/bin 2>/dev/null | tail -1):$PATH"'

def run(c, cmd, timeout=180, title=None):
    if title:
        print("\n===== %s =====" % title)
    cmd = NVM_PATH + " ; " + cmd
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print("[stderr]", err.strip()[:800])
    print("[exit %d]" % code)
    return code, out


def sudo(c, cmd, timeout=120, title=None):
    # 服务器 ubuntu 为 NOPASSWD sudo（2026-09-14 核实），无需再喂密码
    return run(c, "sudo bash -c \"%s\"" % cmd.replace('"', '\\"'),
               timeout=timeout, title=title)


def main():
    c = connect()
    print("已连接 %s@%s" % (USER, HOST))

    if STAGE == "recon":
        run(c, "node -v && npm -v", title="Node / npm")
        run(c, "pm2 list", title="pm2 进程")
        run(c, "ss -tlnp 2>/dev/null | grep -E ':(3000|3100|27017|80|443)\\s' || true", title="关键端口")
        run(c, "docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null || true", title="Docker")
        run(c, "ls /home/ubuntu", title="home 目录")
        run(c, "ls /etc/nginx/sites-enabled/ 2>/dev/null; ls /etc/nginx/conf.d/ 2>/dev/null", title="nginx 配置文件")
        sudo(c, "nginx -T 2>/dev/null | grep -n -B6 -A30 'bhtx.prom1se.cn' | head -120", title="nginx 中该域名的配置")
        run(c, "pm2 describe bhtx 2>/dev/null | grep -E 'status|script|exec cwd|port' | head -8", title="老应用 bhtx 详情")

    elif STAGE == "upload":
        sftp = c.open_sftp()
        def mkdirs(path):
            parts = path.strip("/").split("/")
            cur = ""
            for part in parts:
                cur += "/" + part
                try:
                    sftp.stat(cur)
                except IOError:
                    sftp.mkdir(cur)
        mkdirs(REMOTE)
        mkdirs(REMOTE + "/public/vendor")
        files = [
            (LOCAL + "/server.js", REMOTE + "/server.js"),
            (LOCAL + "/qqbot.js", REMOTE + "/qqbot.js"),
            (LOCAL + "/package.json", REMOTE + "/package.json"),
            (LOCAL + "/package-lock.json", REMOTE + "/package-lock.json"),
            (LOCAL + "/deploy/ecosystem.config.js", REMOTE + "/ecosystem.config.js"),
            (LOCAL + "/deploy/deploy.sh", REMOTE + "/deploy.sh"),
            # .env 特殊：见下方循环——远端已存在则绝不覆盖（本地 env.server 只是新机种子，含空 ADMIN_KEY）
            (LOCAL + "/deploy/env.server", REMOTE + "/.env"),
            (LOCAL + "/public/index.html", REMOTE + "/public/index.html"),
            (LOCAL + "/public/app.js", REMOTE + "/public/app.js"),
            (LOCAL + "/public/style.css", REMOTE + "/public/style.css"),
            (LOCAL + "/public/dashboard.html", REMOTE + "/public/dashboard.html"),
            (LOCAL + "/public/manage.html", REMOTE + "/public/manage.html"),
            (LOCAL + "/public/manage.js", REMOTE + "/public/manage.js"),
            (LOCAL + "/public/dashboard.css", REMOTE + "/public/dashboard.css"),
            (LOCAL + "/public/dashboard.js", REMOTE + "/public/dashboard.js"),
            (LOCAL + "/public/logo.png", REMOTE + "/public/logo.png"),
            (LOCAL + "/public/wordmark.png", REMOTE + "/public/wordmark.png"),
            (LOCAL + "/public/manifest.json", REMOTE + "/public/manifest.json"),
            (LOCAL + "/public/locations.json", REMOTE + "/public/locations.json"),
            (LOCAL + "/public/icon-32.png", REMOTE + "/public/icon-32.png"),
            (LOCAL + "/public/icon-180.png", REMOTE + "/public/icon-180.png"),
            (LOCAL + "/public/icon-192.png", REMOTE + "/public/icon-192.png"),
            (LOCAL + "/public/icon-512.png", REMOTE + "/public/icon-512.png"),
            (LOCAL + "/public/vendor/vue.global.prod.js", REMOTE + "/public/vendor/vue.global.prod.js"),
            (LOCAL + "/public/vendor/qr-creator.min.js", REMOTE + "/public/vendor/qr-creator.min.js"),
        ]
        for l, r in files:
            if r == REMOTE + "/.env":
                # 远端 .env 一旦存在就是线上真相（含随机 JWT_SECRET/轮换后的 ADMIN_KEY），绝不覆盖；新机手工放一次
                try:
                    sftp.stat(r)
                    print("跳过（已存在）", r)
                    continue
                except IOError:
                    pass
            sftp.put(l, r)
            print("↑", r)
        sftp.chmod(REMOTE + "/deploy.sh", 0o755)
        sftp.close()
        print("✅ 上传完成")

    elif STAGE == "start":
        run(c, "cd %s && bash deploy.sh" % REMOTE, timeout=420, title="部署脚本")

    elif STAGE == "nginx-check":
        sudo(c, "ls /etc/nginx/sites-enabled/ 2>/dev/null; ls /etc/nginx/conf.d/ 2>/dev/null", title="nginx 配置文件")
        sudo(c, "nginx -T 2>/dev/null | grep -n -B6 -A35 'bhtx.prom1se.cn' | head -140", title="该域名的 nginx 配置")

    elif STAGE == "nginx-cut":
        # 由 recon/nginx-check 确认配置文件路径后调用：
        # python tools/deploy.py nginx-cut /etc/nginx/sites-available/xxx 3000 3100
        if not EXTRA:
            sys.exit("用法：deploy.py nginx-cut <conf> <旧端口> <新端口>")
        conf = EXTRA[0]
        old_port = EXTRA[1] if len(EXTRA) > 1 else "3000"
        new_port = EXTRA[2] if len(EXTRA) > 2 else "3100"
        sudo(c, "cp %s %s.bak-$(date +%%Y%%m%%d%%H%%M)" % (conf, conf), title="备份 nginx 配置")
        sudo(c, "sed -i 's/127.0.0.1:%s/127.0.0.1:%s/g; s/localhost:%s/localhost:%s/g; s/:%s;/:%s;/g' %s"
             % (old_port, new_port, old_port, new_port, old_port, new_port, conf),
             title="上游端口 %s → %s" % (old_port, new_port))
        sudo(c, "nginx -t", title="nginx 配置测试")
        sudo(c, "systemctl reload nginx && echo reloaded", title="重载 nginx")

    elif STAGE == "verify":
        run(c, "curl -s -o /dev/null -w '首页 %{http_code}\\n' https://bhtx.prom1se.cn/", title="线上首页")
        run(c, "curl -s -o /dev/null -w 'API %{http_code}\\n' https://bhtx.prom1se.cn/api/trips", title="线上 API")
        run(c, "echo \"nickname 泄漏次数: $(curl -s https://bhtx.prom1se.cn/api/trips | grep -c nickname)（应为 0）\"", title="脱敏验证")
        run(c, "curl -s https://bhtx.prom1se.cn/ | head -c 200", title="首页内容抽样")

    elif STAGE == "stop-old":
        run(c, "pm2 stop bhtx && pm2 save", title="停用老后端 bhtx（文件与数据库保留）")

    c.close()


main()
