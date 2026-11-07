# P3 process and secret boundaries

Child processes use the allowlists in `src/process/child-environment.ts`; their
effective environment is not a copy of the orchestrator environment. All
families retain only platform execution essentials. Git and `gh` additionally
receive Git identity/transport settings and the selected GitHub credential.
OpenCode receives credentials only for the provider prefix selected by the
project's configured `provider/model` value. The allowlist is explicit for
OpenAI, Anthropic, Google/Gemini/Vertex, Mistral, Groq, xAI, OpenRouter,
DeepSeek, Azure OpenAI, Cohere, and Bedrock. Unknown or absent provider prefixes
do not receive ambient provider variables; OpenCode retains its normal HOME/XDG
configuration access and its own default behavior, without an orchestrator
model fallback.
Setup/quality commands and `flock` receive no Trello, SMTP, GitHub, or AI
credentials. A project App installation token is registered when issued and is
redacted in subsequent controlled diagnostics; PAT support remains through the
GitHub CLI environment. App private keys are read only from regular files owned
by the orchestrator user with no group/world permissions; successfully read
PEM contents are registered before token generation or later context handling.

Known registered secrets are redacted in process streams and OpenCode prompt
text in literal, percent-encoded, base64/base64url, JSON-escaped forms. Streaming
redaction retains a boundary window for split forms. Recognized credential
field patterns are also redacted. This is a bounded defense for registered
values and known representations; it is not a scanner for arbitrary transforms
or unknown secrets. Context read from attachments or repositories is untrusted;
prompt construction redacts registered values and recognizable credential
patterns, but the scanner does not prove arbitrary repository data safe. During
attachment download, materialization rejects an upload containing a registered
raw credential byte sequence (including across stream chunks) and does not
publish its file or manifest. This is not a scan for encoded or unknown
attachment secrets. Agents can still directly read repository files in ordinary
writable runs, so no universal repository-content guarantee is made. The
Trello comment and content parameters, `gh` CLI content arguments (including
PR bodies/replies), and SMTP subject/body fields also pass through the same
registered-secret sanitizer. This is applied at the relevant outbound content
boundary; request authentication parameters are deliberately not redacted or
rewritten. `docs/p3-verification.md` records named synthetic capture tests and
per-surface limits. These tests do not substitute for realistic outbound
canary scans or prove every future route is covered.
