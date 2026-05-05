# Auto Heal Review

Auto Heal review is an optional, disabled-by-default workflow for diagnosing local failures.

The public template is proposal-only: it can review recent logs and write a repair proposal, but it should not apply code changes automatically.

## Enable

Copy the jobs example if you have not already:

```bash
cp config/jobs.example.json config/jobs.json
```

Then review and enable:

```json
{
  "features": {
    "autoHeal": {
      "enabled": true,
      "mode": "proposal"
    }
  }
}
```

Also enable the `auto-heal-review` job after reviewing its prompt and output path.

## Output

The example writes proposals to:

```text
memory/auto-heal/YYYY-MM-DD-proposal.md
```

Generated proposals are runtime data and should stay out of Git.

