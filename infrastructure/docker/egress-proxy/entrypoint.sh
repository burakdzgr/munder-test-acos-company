#!/bin/sh
set -e
# Docker's stdout/stderr pipes are root-owned; squid's log writer runs as the
# unprivileged 'proxy' user, so widen the pipes before squid drops privileges
# (required for `access_log stdio:/dev/stdout`, 27 §12).
chmod a+w /dev/stdout /dev/stderr || true

# 2026-08-19 canlı bulgu: sert kapanışta (Docker Desktop çökmesi) kalan bayat
# /run/squid.pid, squid'i "already running" FATAL'iyle bloke ediyor ve proxy
# bir daha kalkamıyordu — S8 gereği workspace'lerin TEK çıkışı olduğu için
# tüm npm/ağ istekleri sessizce ölüyordu. Taze süreç, bayat pid'i temizler.
rm -f /run/squid.pid

# O11: render the ACL subnets from the environment compose already uses, so a
# renamed/re-subnetted workspace network cannot silently drift away from the
# ACL and turn the proxy into a default-deny black hole.
: "${WORKSPACE_SUBNET:=172.30.0.0/16}"
# ACOS's own services (server dispatches web.fetch). Compose's default bridge
# network takes an address from Docker's private pool, so the ACL covers the
# RFC1918 ranges the daemon allocates from; the proxy port is never published
# to the host, so nothing outside the compose networks can reach it anyway.
: "${SERVICE_SUBNETS:=172.16.0.0/12 192.168.0.0/16 10.0.0.0/8}"

sed -e "s|\${WORKSPACE_SUBNET}|${WORKSPACE_SUBNET}|g" \
    -e "s|\${SERVICE_SUBNETS}|${SERVICE_SUBNETS}|g" \
    /etc/squid/squid.conf.template > /etc/squid/squid.conf

# D4: the generated per-project include. The shared volume is mounted
# READ-ONLY (the proxy must never be able to widen its own allowlist), and
# squid refuses to start when an `include` target is missing — so the file is
# COPIED into the proxy's own writable config dir. That also means a
# half-written render can never be read mid-parse.
SHARED_INCLUDE=/etc/squid/acos/projects.conf
LIVE_INCLUDE=/etc/squid/generated/projects.conf
mkdir -p /etc/squid/generated
sync_include() {
  if [ -f "$SHARED_INCLUDE" ]; then
    cp "$SHARED_INCLUDE" "$LIVE_INCLUDE"
  else
    echo "# (henüz proje alan adı yok)" > "$LIVE_INCLUDE"
  fi
}
sync_include

squid -k parse -f /etc/squid/squid.conf   # fail fast on a broken render

# Watcher: the server rewrites the include when a project's egress settings
# change. Reconfigure only when the file actually changed, and only when it
# still parses — a bad render must not take the proxy down with it.
(
  last=$(md5sum "$LIVE_INCLUDE" 2>/dev/null | cut -d' ' -f1)
  while sleep 10; do
    current=$(md5sum "$SHARED_INCLUDE" 2>/dev/null | cut -d' ' -f1)
    [ "$current" = "$last" ] && continue
    last="$current"
    sync_include
    if squid -k parse -f /etc/squid/squid.conf >/dev/null 2>&1; then
      squid -k reconfigure -f /etc/squid/squid.conf || true
      echo "acos: egress include reloaded"
    else
      echo "acos: egress include REJECTED (parse failed) — keeping previous config" >&2
    fi
  done
) &

exec squid -NYCd 1 -f /etc/squid/squid.conf
