#!/usr/bin/env bash
# CJH Panel installer (Ubuntu 20.04+).
#  Panel:        curl -fsSL <raw install.sh url> | sudo CJH_REPO=<git repo url> bash
#  Remote node:  curl -fsSL <raw install.sh url> | sudo CJH_REPO=<git repo url> CJH_MODE=node CJH_TOKEN=<16+ chars> bash
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (use sudo)."; exit 1; }
REPO="${CJH_REPO:-}"; MODE="${CJH_MODE:-panel}"; DIR=/opt/cjh-panel
[ -n "$REPO" ] || { echo "Set CJH_REPO=https://github.com/<you>/cjh-panel.git"; exit 1; }
if [ "$MODE" = node ] && [ "${#CJH_TOKEN}" -lt 16 ] 2>/dev/null; then echo "CJH_TOKEN must be 16+ characters"; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git openssl ca-certificates build-essential python3
apt-get install -y openjdk-21-jre-headless || apt-get install -y openjdk-17-jre-headless
NODE_MAJOR=0; command -v node >/dev/null && NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

id cjh >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin cjh
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
mkdir -p "$DIR/data/home"
cd "$DIR"; npm install --omit=dev
chown -R cjh:cjh "$DIR"
NODEBIN=$(command -v node)

if [ "$MODE" = node ]; then
  cat > /etc/systemd/system/cjh-agent.service <<UNIT
[Unit]
Description=CJH Node Agent
After=network-online.target
[Service]
User=cjh
WorkingDirectory=$DIR
Environment=CJH_TOKEN=$CJH_TOKEN HOME=$DIR/data/home
ExecStart=$NODEBIN agent.js
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
  SVC=cjh-agent; PORTS=6768
else
  cat > /etc/systemd/system/cjh-panel.service <<UNIT
[Unit]
Description=CJH Panel
After=network-online.target
[Service]
User=cjh
WorkingDirectory=$DIR
Environment=PORT=6767 HOME=$DIR/data/home
ExecStart=$NODEBIN server.js
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
  SVC=cjh-panel; PORTS=6767
fi
systemctl daemon-reload; systemctl enable --now $SVC

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "$PORTS"/tcp; ufw allow 25565:25765/tcp
fi
IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
echo
if [ "$MODE" = node ]; then echo "Node agent running on port 6768. Add this node in the panel's Admin > Nodes."
else echo "CJH Panel is ready:  http://$IP:6767  or  https://$IP:6767"
     echo "Login: admin / admin  (change the password immediately in Admin)"; fi
