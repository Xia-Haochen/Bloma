# Guide Conversation Reply Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore normal replies in software-v1 guide conversations without turning questions/writing into software specifications or changing production authorization.

**Architecture:** Extend the existing single JSON guide call with a side-effect-free `reply` result. Send bounded public user/assistant dialogue plus host-owned task status; persist/publish replies through the existing `say` path. Keep scope-confirm/UX/production/C/V/release and budgets unchanged; no new classifier request, Agent, state machine, tools or provider settings.

**Tech Stack:** TypeScript, Vitest, existing GuideModelOptions/PrdBackplane/callLlmForJson.

---

## Evidence and upstream adaptation

Root-cause evidence: current session workbench `bloma-guide-diagnosis/report.md`; effective system hash matches the real failed conversation ledger. Reference local Proma upstream bf3e98ca61dd8365eceaef876c0f7473700878a6, `apps/electron/src/main/lib/system-prompt-manager.ts`: normal chat retains an explicit assistant identity and conversational context. Adapt those responsibilities to Bloma's existing guide call rather than importing its generic chat engine/configuration or weakening software gates.

## Task 1 — Failing boundary tests

Files: `tests/unit/guide/lean-conversation.test.ts` (new).

1. Test a reply to “你是谁”: one existing model call, Bloma identity/direct-reply contract in system, no PRD/confirmation/name mutation, public body persists and survives history reload.
2. Test empty/malformed reply rejection and bounded failure; no accidental brief.
3. Test public user/assistant dialogue is retained, internal system/tool/image blocks excluded.
4. Test reply while scope is pending/dismissed/adjusting preserves PRD bytes, confirmation identity/state, project stage and no implicit build even if text contains “直接做”.
5. Test a genuine software brief and real scope adjustment still produce confirmation and do not mark requirements confirmed; existing stale/pause/UX tests remain.
6. Run new tests against baseline and retain red log outside Git.

## Task 2 — Minimal implementation

Modify `main/guide/lean-brief.ts`: introduce `{action:'reply';text:string}` in the discriminated union, validate nonempty string, extend the existing system contract with real Bloma identity and the distinction between dialogue and software scope; never let reply carry out actions.

Modify `main/guide/lean-guide.ts`: keep canonical user source strings for existing contract identities; add public user/assistant dialogue to both initial and retry payloads and host-owned guide stage/confirmation state. Before request, emit the current stored stage rather than falsely switching paused tasks to clarifying. After the abort check, handle reply with `say(result.text); return` before any scope/name/auto-build writes. Do not alter explicit card/confirm/stop paths or task-card semantics.

Run red tests until green without weakening expectations; run all existing guide/parser/confirmation/contract tests, typecheck, docs and production build. No paid supplier tests or user-data mutation.

## Task 3 — Verification, review and delivery

1. Preserve original registry/session/index/usage/confirmation/PRD and user's dirty document hashes. All fixture runs use fresh private PROMA_HOME; caches stay in the worktree, not shared node_modules.
2. Add a controlled original-runAgent entry test if practical, and verify rendered reply/history using isolated UI evidence. A model stub is not supplier quality certification; component/browser evidence is not real App acceptance.
3. Independently review the production diff for implicit confirmation, scope loss, hidden extra calls or history injection; resolve confirmed issues and rerun affected tests.
4. Commit only this batch with `Made-with: Proma`; protect the original dirty document. Fast-forward the tested repair into sprint2 if its baseline is still unchanged, update main build freshness, do not push/restart the usual App or resume paid projects.
5. Handoff records exact source/commands/results and remaining real-supplier/App acceptance boundaries. Update the current project memory once with verified outcome, not intermediate claims.
