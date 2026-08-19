# acos/egress-proxy — the only route out of the internal acos-workspaces
# network (S8). Squid with a default-deny allowlist (27 §12).
#
# O11: the config is a TEMPLATE rendered at boot from the same environment
# compose uses for the workspace network, so the ACL and the network can never
# drift apart (a mismatch made squid deny everything, silently).
FROM ubuntu/squid:latest
COPY squid.conf.template /etc/squid/squid.conf.template
COPY entrypoint.sh /usr/local/bin/acos-entrypoint.sh
RUN chmod +x /usr/local/bin/acos-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/acos-entrypoint.sh"]
