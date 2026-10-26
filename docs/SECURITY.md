# Security, privacy, and the limits of this build

This is a demonstration with a realistic security posture, not an audited product. It has not been penetration tested, no third party has reviewed it, and no claim of legal compliance is made anywhere in this repository.

## Authentication

- Passwords: scrypt, 16,384 iterations, 16 byte salt per user, 64 byte key, constant time comparison.
- Sessions: 64 hex character random id, stored server side in `session`, delivered as `<id>.<hmac>` signed with `SESSION_SECRET`. Reading a session requires a valid signature, an unexpired row, and an active user.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `COOKIE_SECURE=1`. There is no remember-me and no token in localStorage.
- Logout deletes the session row, so a copied cookie stops working immediately.
- Failed logins are audited with the attempted email truncated, and the response is identical for an unknown email and a wrong password.

## Authorisation

Three roles, checked server side in every route:

| Capability | EXEC | COMPLIANCE | ADMIN |
| --- | --- | --- | --- |
| Read pages and API | yes | yes | yes |
| Run compliance check | no | yes | yes |
| Upload and assess a document | no | yes | yes |
| Approve or reject an escalation | no | yes | yes |
| Record obligation outcome | no | yes | yes |

The interface hides disabled actions, but the route refuses them regardless of what the browser sends. `tests/http.test.ts` proves an EXEC session gets 403 on `POST /compliance/run`.

## Request integrity

- CSRF: per session token, embedded in every form, verified on every state change. A forged token returns 403 and writes nothing.
- Sessions are not accepted from a query string, only from the cookie.
- Identifiers are validated as UUIDs before reaching SQL, so malformed input becomes a 400 rather than a database error.
- All SQL uses parameters. There is no string interpolation of user input anywhere.
- Responses never include stack traces or database messages; those go to the server log with a request id.

## Rate limits

| Endpoint | Limit |
| --- | --- |
| `POST /login` | 8 per minute per IP |
| `POST /documents` | 12 per minute per IP |
| Everything else | no additional limiter (single instance demo) |

`trustProxy` is enabled because the app is expected behind a TLS terminating proxy. If you deploy it directly exposed, remove that flag so clients cannot spoof `X-Forwarded-For` and evade limits.

## Uploads and the model boundary

- Accepted: `.txt` and `.md`, `text/plain` or `text/markdown`, maximum 256 KB, one file per request.
- Rejected before parsing: wrong extension, wrong MIME, empty file, oversized file.
- Stored as text with control characters stripped. Never written to disk as an executable, never served back as an attachment, never passed to a shell.
- Duplicate bytes for the same obligation are detected by SHA-256 and not re-assessed.
- The model receives at most 18,000 characters, wrapped in explicit markers, with a system instruction that document text is data and that any instruction inside it must be reported, not followed.
- The model has no tools and no database access. Its output is parsed as JSON and validated by a schema with hard length bounds before a single row is written.
- Prompt injection cannot escalate privileges because the agent's actions are a closed set: draft an escalation or do nothing. It cannot approve, execute, send, or query.

## Secrets

- `.env` is git ignored; `.env.example` contains placeholders only.
- Secrets are read once at boot into a frozen config object. They never appear in pages, API responses, logs, or audit detail.
- The seed password can be overridden with `SEED_PASSWORD`; the default is documented and must be changed on any host that is not a throwaway demonstration.
- Rotating `SESSION_SECRET` invalidates every existing session, by design.

## Audit

`audit_event` records actor type, actor id, action, entity, structured detail, and request id. A trigger raises an exception on UPDATE or DELETE, so the application cannot rewrite history and a stray migration cannot either.

What that is not: tamper proof storage. A superuser can disable the trigger, and anyone with database backups can alter them. Real immutability needs append only storage with external anchoring (WORM storage, a hash chain published somewhere else, or a SIEM with independent retention). The honest description is "append only at the application and database level", which is what the interface says.

## Data protection, Nigeria Data Protection Act 2023

The demonstration contains no real personal data. The seed names are invented. The design does anticipate the Act's principles:

- **Lawful basis and minimisation**: the system stores obligation owners as role titles, not personal records; documents are the only free text and are treated as untrusted.
- **Retention**: audit and assessment records are retained for the life of the demonstration; the reset script is the deletion mechanism. A production deployment would need a defined schedule per record class, and the DPIA in the seed is itself an example of the sort of document that schedule should reference.
- **Access control**: least privilege by role, server side, with every decision audited.
- **Data subject rights**: not implemented. There is no subject index, no export, and no erasure workflow, because there are no data subjects in a synthetic portfolio.
- **Cross border transfer**: if a model provider outside Nigeria is configured, document excerpts leave the jurisdiction. That is a decision a real deployment must document before enabling the AI rail, and it is why the system runs deterministically with no provider by default.
- **Accountability**: the audit trail and the architecture records in this repository are the evidence trail, not a compliance certificate.

None of this constitutes compliance. A real deployment would need a DPIA, a named DPO where the Act requires one, a records-of-processing register, a breach response procedure, and legal review. The system is built so those obligations can be met, not so they can be skipped.

## Known weaknesses

- No account lockout beyond rate limiting; a distributed attacker could still guess weak demo passwords.
- No MFA, no password reset, no session listing for the user.
- The in-process scheduler stops when the process stops; `/healthz` exposes that state rather than hiding it.
- The demonstration seed password is public in this repository by design; change it before exposing an instance.
- Error pages are generic, but response timing could still reveal whether an email exists to a patient attacker.
- No dependency scanning, SBOM, or CI pipeline is configured yet.
