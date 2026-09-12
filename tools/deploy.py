# -*- coding: utf-8 -*-
"""BHTXweb 部署工具（开发用）
用法：python tools/deploy.py <密码> <stage>
stage: recon | upload | start | nginx-check | nginx-cut | verify | stop-old
密码只用于建立连接，不会打印。
"""
import sys
import os
import time
import paramiko

HOST, USER = "REDACTED_HOST", "ubuntu"
PW = sys.argv[1] if len(sys.argv) > 1 else ""
STAGE = sys.argv[2] if len(sys.argv) > 2 else "recon"
LOCAL = r"D:\Projects\BHTXweb"
REMOTE = "/home/ubuntu/bhtxweb"


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PW, timeout=15, banner_timeout=15)
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
    # 通过 stdin 传密码给 sudo -S，命令行不留痕
    return run(c, "sudo -S -p '' bash -c \"%s\"" % cmd.replace('"', '\\"'),
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
            (LOCAL + "/package.json", REMOTE + "/package.json"),
            (LOCAL + "/package-lock.json", REMOTE + "/package-lock.json"),
            (LOCAL + "/deploy/ecosystem.config.js", REMOTE + "/ecosystem.config.js"),
            (LOCAL + "/deploy/deploy.sh", REMOTE + "/deploy.sh"),
            (LOCAL + "/deploy/env.server", REMOTE + "/.env"),
            (LOCAL + "/public/index.html", REMOTE + "/public/index.html"),
            (LOCAL + "/public/app.js", REMOTE + "/public/app.js"),
            (LOCAL + "/public/style.css", REMOTE + "/public/style.css"),
            (LOCAL + "/public/logo.png", REMOTE + "/public/logo.png"),
            (LOCAL + "/public/wordmark.png", REMOTE + "/public/wordmark.png"),
            (LOCAL + "/public/manifest.json", REMOTE + "/public/manifest.json"),
            (LOCAL + "/public/icon-32.png", REMOTE + "/public/icon-32.png"),
            (LOCAL + "/public/icon-180.png", REMOTE + "/public/icon-180.png"),
            (LOCAL + "/public/icon-192.png", REMOTE + "/public/icon-192.png"),
            (LOCAL + "/public/icon-512.png", REMOTE + "/public/icon-512.png"),
            (LOCAL + "/public/vendor/vue.global.prod.js", REMOTE + "/public/vendor/vue.global.prod.js"),
        ]
        for l, r in files:
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
        # python tools/deploy.py PW nginx-cut /etc/nginx/sites-available/xxx 3000 3100
        conf = sys.argv[3]
        old_port = sys.argv[4] if len(sys.argv) > 4 else "3000"
        new_port = sys.argv[5] if len(sys.argv) > 5 else "3100"
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
