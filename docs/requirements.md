# Agent Orchestrator — Requirements

## How we work with this document

This is the single shared, human-readable source of truth for how Agent Orchestrator **should** work, not a description of what its code currently does.

- We develop it together through conversation, one small topic and one question at a time. The user approves or corrects each proposed requirement before it is added.
- ChatGPT updates this file in [draft PR #208](https://github.com/emilhornlund/agent-orchestrator/pull/208). The user does not need to keep a separate copy or edit GitHub directly.
- Keep the document concise and understandable; avoid implementation details unless they are essential to the intended behavior. Do not invent decisions to fill gaps.
- Do not merge the PR until the user explicitly approves the complete requirements document. Implementation audits and fixes happen afterward.

**To resume in a new chat:** Say “Continue the Agent Orchestrator requirements from [PR #208](https://github.com/emilhornlund/agent-orchestrator/pull/208).” ChatGPT should read the latest `docs/requirements.md` from that PR, use it as the authoritative record of approved requirements, then ask the next small question. Do not rely on memory of earlier chats or start over.

## Purpose

Agent Orchestrator automatically turns Trello tasks into implemented, tested, and reviewed GitHub pull requests using AI agents. It manages the end-to-end workflow while allowing humans to control the final outcome.
