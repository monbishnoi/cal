# Codex Notification Loop

Cal can delegate coding work to Codex without losing the conversation when Codex needs a decision.

## One Strand, One Timeline

Every Cal-initiated Codex task stays in the dedicated Codex Strand:

- Yellow `working`: Codex is running.
- Blue `attention`: Codex asked a blocking question.
- Green `ready`: the task completed or stopped.

When Codex asks a blocking question, Cal analyzes the complete SDK response, posts the question, and drafts a proposed answer in the same Strand. The Gateway also sends a short nudge through its configured notification channel.

In the default `/ask-me` mode:

- Reply `yes` to approve Cal's draft.
- Reply `no` to keep the Strand pending.
- Enter a substantive reply to replace Cal's draft.

Approved or replacement answers resume the same Codex thread. The next Codex result is appended to the same Strand.

## Autonomous Mode

`/dont-ask-me` requests unattended question handling. Cal asks for one confirmation before changing the standing policy. In this mode, Cal can answer and resume Codex automatically for up to three consecutive question-and-answer cycles. A fourth unresolved question falls back to blue attention.

Use `/ask-me` to restore approval-first behavior immediately.

The local policy is stored in `data/codex-notification-policy.json`. This runtime file is ignored by Git.

## Scope

The loop applies only to tasks started by Cal through `codex_send`. It does not watch unrelated Codex tasks, stream intermediate Codex events, or create out-of-band task timelines.

## Verification

Run:

```bash
npm test
```

The test suite covers the isolated analyzer completion, policy confirmation and persistence, tool registration, and the blue attention UI. The bridge's end-to-end loop tests additionally cover approval, replacement replies, same-thread resume, autonomous mode, the three-cycle cap, notifications, and Strand status transitions.
