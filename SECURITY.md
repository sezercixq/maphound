# Security policy

MapHound processes untrusted input by design: JavaScript bundles and source maps from arbitrary
websites. We take bugs that let that input escape its sandbox seriously.

## Supported versions

MapHound is in early development. Security fixes go into the latest release and `main`.

| Version | Supported |
| ------- | --------- |
| 0.5.x   | Yes       |
| older   | No        |

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/sezercixq/maphound/security/advisories/new).

Include what you can of:

- affected version or commit, Chrome version and OS
- a description of the issue and its impact
- a minimal proof of concept (for example a crafted source map), with fake data only
- whether you want to be credited, and under which name

We aim to acknowledge reports within 3 working days and to share an assessment within 10. We will
keep you informed, agree on a disclosure date with you (normally within 90 days, sooner once a fix
ships) and credit you in the advisory unless you prefer otherwise.

## In scope

Issues in MapHound itself, for example:

- Path traversal or Zip Slip: a source map path that writes outside the archive folder on extraction
- Code execution or HTML injection in the side panel from crafted file names, URLs or findings
- Regular expression denial of service, memory or CPU exhaustion from crafted bundles or maps
- Data leaving the browser: any network request other than fetching the enabled site's own scripts
  and maps, or findings, secrets or URLs reaching a third party
- Bypassing the per-site permission model or scope (fetching from origins the user did not enable)
- Exposure of stored findings or raw secrets to web pages or other extensions

## Out of scope

- Secrets that MapHound finds on a website. Those belong to the site owner: report them to the owner
  through their security contact or bug bounty program, and do not use them.
- False positives and missed detections (please open a regular issue, with fake values).
- Issues that need a malicious extension, a compromised browser or physical access.
- Weaknesses of the `VITE_MH_E2E=1` test build, which is not distributed.

## Safe harbor

We will not pursue legal action against good-faith research that respects this policy, avoids
privacy violations and service disruption, and gives us reasonable time to fix the issue.
