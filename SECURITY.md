# Security Policy

## Reporting a Vulnerability

Please do not open public issues for suspected security vulnerabilities.

Preferred: use GitHub "Report a vulnerability" (Security Advisories) for this repository. This creates a private report thread.

If Security Advisories are unavailable in your context, open a minimal issue that does not include exploit details and ask for a private channel.

## Scope

In scope:
- The production server and APIs
- Socket.IO and any real-time game state
- Authentication/session handling and reconnect flows
- Web pages that can be accessed by players/operators
- Connectors or extensions shipped from this repository

Out of scope:
- Issues requiring physical access to the host
- Social engineering
- Denial-of-service that relies on extremely high traffic volumes (unless a small request volume can cause a crash)

## Safe Harbor

We support good-faith security research.
- Do not access or modify other users' data.
- Do not disrupt services.
- Keep testing to accounts/systems you own or have explicit permission to test.
- Share reproduction steps privately.

## What to Include

- Affected component(s) and version/commit
- Impact assessment (what can an attacker do?)
- Reproduction steps or proof-of-concept
- Any mitigation ideas you found

## Response Targets

We aim to acknowledge reports within 3 business days and provide a remediation plan or timeline as soon as we can.

