#!/usr/bin/env bash
# Run on the PROXMOX HOST shell. Creates a Debian 12 container called "graphhopper"
# and runs setup-container.sh inside it.
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/ytzsch/proper-roads/main/server"
HOSTNAME_CT="graphhopper"
CORES=4
MEMORY=9216     # MB. Plenty for the build; HA keeps the rest.
SWAP=2048
DISK=32         # GB

command -v pct >/dev/null || { echo "Run this on the Proxmox host shell."; exit 1; }

if pct list | awk '{print $NF}' | grep -qx "$HOSTNAME_CT"; then
  echo "A container called $HOSTNAME_CT already exists. Stopping so nothing is overwritten."; exit 1
fi

CTID=$(pvesh get /cluster/nextid)

# Where container disks go: local-lvm if present, else local.
if pvesm status | awk '{print $1}' | grep -qx local-lvm; then STORAGE=local-lvm; else STORAGE=local; fi

echo "==> Getting the Debian 12 template"
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)
[ -n "$TEMPLATE" ] || { echo "Couldn't find a Debian 12 template."; exit 1; }
if ! pveam list local | grep -q "$TEMPLATE"; then pveam download local "$TEMPLATE"; fi

echo "==> Creating container $CTID ($HOSTNAME_CT) on $STORAGE"
pct create "$CTID" "local:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME_CT" --cores "$CORES" --memory "$MEMORY" --swap "$SWAP" \
  --rootfs "$STORAGE:$DISK" --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian \
  --description "Proper Roads routing server (GraphHopper + Tailscale)"

# Tailscale needs the tun device inside the container.
cat >> "/etc/pve/lxc/$CTID.conf" <<'EOF'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF

pct start "$CTID"
echo "==> Waiting for the container's network"
for i in $(seq 1 30); do
  pct exec "$CTID" -- bash -c "getent hosts deb.debian.org >/dev/null" 2>/dev/null && break
  sleep 2
done

pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null"
pct exec "$CTID" -- bash -c "curl -fsSL $REPO_RAW/setup-container.sh -o /root/setup-container.sh && bash /root/setup-container.sh"

echo
echo "Done. Container $CTID ($HOSTNAME_CT) is set up."
