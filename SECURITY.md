# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security Advisories rather than a public issue. Include affected versions, reproduction steps, and expected impact.

## Security boundaries

- Index only roots and websites you trust.
- Web indexing requires an explicit hostname allowlist and revalidates redirects.
- File indexing excludes common secret files and generated dependency directories, but it is not a complete secret scanner.
- Indexed content and embeddings are stored as plaintext in PostgreSQL.
- The project-card cache is stored as plaintext in `.opencode/project-card.md`.

Rotate any credential that may have been indexed and rebuild the affected index.
