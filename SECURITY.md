# Security notes

This is a local example router, not a security boundary against software already running as your user. It accepts requests only on the reserved loopback interface, rejects non-loopback Host/Origin headers and requires JSON for POST requests. These checks reduce network exposure and browser cross-origin requests; they do not protect against a malicious local process.

- Inspect the source before running it. Keep your Codex version, Node.js and operating system updated.
- Store provider keys outside the repository, with permissions limited to your user. Never include keys in issues, logs, screenshots, prompts or commits. Revoke a key immediately if exposed.
- Do not make the listener reachable from another machine: no public bind, port forwarding, reverse proxy or shared tunnel. A shared or remote deployment needs an independent security design.
- The native route forwards the incoming Codex authorization only to the native Codex service. External routes replace it with the corresponding external provider key. Review these routes if you change upstream URLs.
- A combined desktop setup routes native models through this local process too. Keep a backup and test rollback before relying on it.
- Provider costs and model/tool compatibility are outside this project's control. Start with small test requests and set spending limits at your provider where available.

If you find a vulnerability, do not post credentials or exploitable private data in a public issue. Use the repository's private vulnerability-reporting option if available; otherwise open an issue containing only a non-sensitive summary and request a private contact channel.
