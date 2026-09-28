#!/bin/sh
# How the portal-read worker starts Chromium (ADR 0057 §6). The worker hands
# the runner this script's path as the browser to launch, and this script
# starts the real one, named by PORTAL_CHROMIUM_PATH (which the worker sets),
# with the two things the worker requires of any browser that renders a
# portal's pages:
#
#  - Its sandbox. Playwright passes --no-sandbox unless it is asked not to, and
#    that switch is dropped here, so every renderer runs under seccomp in its
#    own namespaces, where it can open no file and see no other process.
#    Chromium refuses to start where its sandbox cannot (as root, or with no
#    unprivileged user namespaces) rather than running without one. Any other
#    switch that turns part of the sandbox off ends the launch.
#
#  - An environment built from nothing: PATH, HOME, TMPDIR and the locale.
#    The worker's own environment holds AWS credentials and the rest of its
#    configuration, and no process that renders a page is given any of it.
#
# It prints nothing but its own refusals, which name a switch or a variable
# and never a value the worker holds.
set -eu

chromium=${PORTAL_CHROMIUM_PATH:-}
case $chromium in
  /*) ;;
  *)
    echo 'portal-read: PORTAL_CHROMIUM_PATH is not an absolute path' >&2
    exit 64
    ;;
esac
if [ ! -x "$chromium" ]; then
  echo 'portal-read: PORTAL_CHROMIUM_PATH is not an executable' >&2
  exit 64
fi

for arg do
  shift
  case $arg in
    --no-sandbox | --no-sandbox=*)
      # Playwright's default. The worker's browser keeps its sandbox.
      continue
      ;;
    --single-process | --single-process=* | --no-zygote | --no-zygote=* | --disable-*sandbox*)
      echo "portal-read: refusing to start Chromium with ${arg%%=*}" >&2
      exit 64
      ;;
  esac
  set -- "$@" "$arg"
done

exec /usr/bin/env -i \
  PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" \
  HOME="${HOME:?}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  ${LANG+"LANG=$LANG"} \
  ${LANGUAGE+"LANGUAGE=$LANGUAGE"} \
  ${LC_ALL+"LC_ALL=$LC_ALL"} \
  ${TZ+"TZ=$TZ"} \
  "$chromium" "$@"
