#!/usr/bin/env bash
# Runs INSIDE the graphhopper container. Installs Java, GraphHopper and the GB map,
# sets up the service, a monthly map refresh and Tailscale.
set -euo pipefail

GH_VERSION="10.2"
REPO_RAW="https://raw.githubusercontent.com/ytzsch/proper-roads/main/server"
MAP_URL="https://download.geofabrik.de/europe/great-britain-latest.osm.pbf"
DIR=/srv/gh

echo "==> Installing Java and tools"
apt-get update -qq
apt-get install -y -qq openjdk-17-jre-headless curl ca-certificates >/dev/null

echo "==> Creating gh user and folders"
id gh >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin gh
mkdir -p "$DIR"

echo "==> Downloading GraphHopper $GH_VERSION"
curl -fsSL -o "$DIR/graphhopper-web.jar" \
  "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/$GH_VERSION/graphhopper-web-$GH_VERSION.jar"
curl -fsSL -o "$DIR/config.yml" "$REPO_RAW/config.yml"

echo "==> Downloading the Great Britain map (about 1.8 GB, a few minutes)"
curl -fL --progress-bar -o "$DIR/great-britain-latest.osm.pbf" "$MAP_URL"
chown -R gh:gh "$DIR"

echo "==> Installing the service"
cat > /etc/systemd/system/graphhopper.service <<'EOF'
[Unit]
Description=GraphHopper routing server (Proper Roads)
After=network-online.target
Wants=network-online.target

[Service]
User=gh
WorkingDirectory=/srv/gh
ExecStart=/usr/bin/java -Xms1g -Xmx6g -jar /srv/gh/graphhopper-web.jar server /srv/gh/config.yml
Restart=on-failure
RestartSec=30
# The first start builds the routing graph, which can take 30-60 minutes.
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

echo "==> Installing the monthly map refresh"
cat > /usr/local/bin/gh-refresh-map <<EOF
#!/usr/bin/env bash
# Fetch a fresh GB map and rebuild the routing graph. Routing is offline while it rebuilds.
set -euo pipefail
cd $DIR
curl -fsSL -o great-britain-latest.osm.pbf.new "$MAP_URL"
systemctl stop graphhopper
mv great-britain-latest.osm.pbf.new great-britain-latest.osm.pbf
rm -rf graph-cache
chown -R gh:gh $DIR
systemctl start graphhopper
EOF
chmod +x /usr/local/bin/gh-refresh-map

cat > /etc/systemd/system/gh-refresh-map.service <<'EOF'
[Unit]
Description=Refresh GB map for GraphHopper
[Service]
Type=oneshot
ExecStart=/usr/local/bin/gh-refresh-map
EOF
cat > /etc/systemd/system/gh-refresh-map.timer <<'EOF'
[Unit]
Description=Monthly GB map refresh (1st of the month, 03:30)
[Timer]
OnCalendar=*-*-01 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now graphhopper.service gh-refresh-map.timer

echo "==> Installing Tailscale"
curl -fsSL https://tailscale.com/install.sh | sh >/dev/null

echo
echo "============================================================"
echo " GraphHopper is building the GB routing graph in the background."
echo " That takes roughly 30-60 minutes. Follow it with:"
echo "   journalctl -u graphhopper -f"
echo " It's ready when you see a line containing: Started"
echo
echo " Now connect this container to Tailscale. Open the link it prints:"
echo "============================================================"
tailscale up --hostname=graphhopper
tailscale serve --bg 8989
echo
echo "Your routing server address is the https:// line below (paste it into the app's Settings):"
tailscale serve status
