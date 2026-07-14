# Security Policy

Nexus Scheduler handles authentication, encrypted credentials (LibreChat
API keys, SMTP passwords, webhook secrets), and an audit trail, and is
often deployed in regulated or air-gapped environments. We take security
reports seriously.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub
issues, discussions, or pull requests** — that discloses the issue before
a fix is available.

**Preferred — GitHub private vulnerability reporting** (when enabled on
this repository):

1. Go to the **Security** tab of this repository.
2. Click **"Report a vulnerability"** to open a private security advisory.
3. Include as much detail as you can — affected version/commit, a
   description of the issue, reproduction steps or a proof of concept, and
   the potential impact.

**If that option is not available**, contact a repository maintainer
privately (for example, through their GitHub profile) to arrange a secure
channel before sharing any details — please still avoid posting anything
about the vulnerability publicly.

We will acknowledge your report as soon as we reasonably can, keep you
informed of remediation progress, and credit you in the advisory once a
fix is released (unless you prefer to remain anonymous).

Please give us a reasonable opportunity to release a fix before any
public disclosure.

## Scope

Security-relevant areas include, but are not limited to:

- Authentication and session handling (local auth and OIDC).
- Authorization / access control (project ACLs, team membership,
  API-key ownership).
- Encryption and handling of secrets at rest and in transit.
- The audit trail and its syslog/SIEM forwarding.
- The isolated PDF rendering service.

## Supported Versions

This project is pre-1.0 and evolving quickly. Security fixes are applied
to the latest `main`; please verify a report against the most recent
commit before submitting.
