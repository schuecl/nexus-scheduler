# Local Compose stand-in for an on-prem syslog/SIEM receiver — exists
# purely so the syslog audit-event mirror (REQUIREMENTS §7.1) can be
# exercised end to end locally: UDP, plain TCP (RFC 6587 framing), and
# TLS with a private CA (the exact three paths Nexus Scheduler's syslog
# client supports). rsyslog is REQUIREMENTS §3's preferred kind of
# tooling ("well-known, established... rather than niche/bespoke"), so
# this is a real rsyslog instance, not a toy listener script.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    rsyslog rsyslog-gnutls \
    && rm -rf /var/lib/apt/lists/*

COPY rsyslog.conf /etc/rsyslog.conf

EXPOSE 514/udp 601/tcp 6514/tcp

CMD ["rsyslogd", "-n"]
