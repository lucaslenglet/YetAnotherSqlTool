# Security Policy

## Supported versions

Only the latest release receives security fixes. Please update before reporting.

## Reporting a vulnerability

Do not open a public issue. Report privately through GitHub's private vulnerability reporting:

<https://github.com/lucaslenglet/YetAnotherSqlTool/security/advisories/new>

Please include:

- the affected extension version, VS Code version and operating system;
- the database engine and authentication type involved, if relevant;
- a description of the issue and its impact;
- steps to reproduce or a proof of concept;
- any suggested fix.

Never include real passwords, tokens or production data in a report.

## What to expect

This is a volunteer-maintained project. We aim to acknowledge a report within a few days, to
keep you informed while we investigate, and to publish a fix and an advisory once a patched
release is available. Reporters are credited unless they prefer otherwise.

## Scope

YAST is a database client that handles credentials and runs user-supplied SQL. Areas of particular interest:

- Credentials: passwords are stored in VS Code `SecretStorage`, never in settings or logs.
- Microsoft Entra ID tokens are obtained from VS Code's built-in Microsoft account provider or,
  in the "Default" and "Service Principal" modes, from the Azure Identity library. They must
  only be sent to Azure SQL / Azure PostgreSQL hosts and to the servers the user listed in
  `yast.entraId.allowedServers`.
- Workspace trust: connections defined in an untrusted workspace are ignored.
- Webviews: message handling between the extension and its webviews.
- Connection strings and logs leaking secrets.

Out of scope: running arbitrary SQL against a database you are connected to (that is the purpose
of the tool), and vulnerabilities in the database servers or in VS Code itself.
