# Security Policy

## Reporting a Vulnerability

**Do NOT open a public issue for security vulnerabilities.**

Instead, please report it privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability): go to the repository's **Security** tab → **Report a vulnerability**. Include:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

The maintainers will work with you to understand and address the issue before any public disclosure.

## Scope

Security issues in the following are in scope:

- **Scripts** (`*.mjs`) — command injection, path traversal, SSRF
- **Dashboard** (`dashboard/`) — any Go binary vulnerabilities
- **Templates** (`templates/`) — XSS in generated HTML/PDF
- **Configuration** — secrets exposure, unsafe defaults

## Out of Scope

- Issues in third-party dependencies (report upstream)
- Issues requiring physical access to the user's machine
- Social engineering attacks
- get-the-job is a local tool — there is no hosted service to attack

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will credit the reporter (unless they prefer anonymity) in the release notes.
