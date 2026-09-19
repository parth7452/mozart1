# clamd and the token-checked HTTP front door in one container, so clamd can be
# bound to loopback and never routed (ADR 0018).
FROM clamav/clamav:1.4

# Node for the front door, and su-exec to drop it out of root. The base is
# Alpine (`clamav/clamav:1.4` is the Alpine variant; `-debian` is the suffixed
# one), and the service itself has no npm dependencies.
RUN apk add --no-cache nodejs su-exec

# Bind clamd to loopback and cap what it will accept.
#
# The shipped conf sets `TCPSocket 3310` and nothing else that matters here —
# no TCPAddr, so clamd would otherwise listen on every interface, which is the
# one line in this file that has to be right. The size options are unset and
# default to 25M, one megabyte under the 25 MB the upload route allows, so a
# file at the limit would be refused by the scanner rather than scanned.
#
# The deletes are belt-and-braces for a future base image that starts setting
# these: clamd takes the last value, so an append alone would still win, but
# only the delete makes that obvious to someone reading the resulting file.
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
