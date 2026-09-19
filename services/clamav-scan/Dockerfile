# clamd and the token-checked HTTP front door in one container, so clamd can be
# bound to loopback and never routed (ADR 0018).
FROM clamav/clamav:1.4

# Node for the front door. The base is Alpine; this is the only addition, and
# the service itself has no npm dependencies.
RUN apk add --no-cache nodejs

# Bind clamd to loopback and cap what it will accept. The base image already
# sets TCPSocket and Foreground, so these are edits rather than appends —
# a duplicated scalar option makes clamd complain on startup.
RUN sed -i \
      -e '/^TCPAddr /d' -e '/^StreamMaxLength /d' \
      -e '/^MaxFileSize /d' -e '/^MaxScanSize /d' \
      /etc/clamav/clamd.conf \
 && printf '%s\n' \
      'TCPAddr 127.0.0.1' \
      'StreamMaxLength 26M' \
      'MaxFileSize 26M' \
      'MaxScanSize 200M' \
    >> /etc/clamav/clamd.conf

COPY server.mjs /srv/server.mjs
COPY entrypoint.sh /srv/entrypoint.sh
RUN chmod +x /srv/entrypoint.sh

ENV PORT=8080
EXPOSE 8080

# Long start period on purpose: loading the signature database is ~1 GB and
# takes 30-60s, and /health reports unhealthy honestly until clamd answers PING.
HEALTHCHECK --interval=30s --timeout=10s --start-period=240s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/srv/entrypoint.sh"]
