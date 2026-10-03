#!/bin/sh
# Executed only by the trusted host during explicit environment preparation.
set -eu
id hb-runtime >/dev/null 2>&1 || useradd --create-home --shell /bin/bash hb-runtime
id hb-worker >/dev/null 2>&1 || useradd --no-create-home --home-dir /workspace --shell /usr/sbin/nologin hb-worker
id hb-proxy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin hb-proxy
chmod 0700 /home/hb-runtime
install -d -m 0755 /home/hb-runtime/control /opt/harakiri/rootfs
chown root:root /home/hb-runtime/control
install -d -m 0700 -o hb-worker -g hb-worker /workspace
install -d -m 0755 /opt/harakiri/rootfs/usr /opt/harakiri/rootfs/bin /opt/harakiri/rootfs/lib /opt/harakiri/rootfs/lib64 /opt/harakiri/rootfs/workspace /opt/harakiri/rootfs/tmp
install -m 0644 /opt/harakiri/files.py /usr/local/lib/harakiri-files.py
python3 /opt/harakiri/install-runtime.py
cat >/etc/systemd/system/hb-proxy.service <<'UNIT'
[Unit]
Description=Harakiri provider-only egress
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 /opt/harakiri/proxy.py
User=hb-proxy
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictNamespaces=yes
ProtectControlGroups=yes
MemoryMax=96M
TasksMax=16
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
# Runtime services are transient, with a host-selected lease and a mandatory
# ExecStopPost that tears down the full agent slice even after a broker crash.
systemctl daemon-reload
systemctl enable --now hb-proxy.service
systemctl restart hb-proxy.service
