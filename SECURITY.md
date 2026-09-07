# Security

Dewey treats note paths as untrusted input and keeps its derived index outside
notes. It does not make retrieved text trustworthy or prevent a host from sending
that text to a cloud model. Keep provider permissions appropriate to your data.

Report suspected vulnerabilities through this repository's private security
advisory channel. Include a minimal synthetic reproduction, affected version,
expected behavior and actual behavior. Do not include private notes or secrets.

The 0.1.x release line receives fixes. Dependency changes run native storage and
package-install checks on Windows, macOS and Linux before release.
