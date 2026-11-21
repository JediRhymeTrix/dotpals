# Fork upstream maintenance

This automation belongs only to `JediRhymeTrix/dotpals`; it does not submit anything to the upstream project.

## Schedule and behavior

`.github/workflows/upstream-sync.yml` runs daily at **06:23 UTC** and can be started from Actions → Upstream sync → Run workflow on `main`. GitHub schedules are best effort and may be delayed; inactive public repositories may have scheduled workflows disabled after 60 days. A failed push-CI run on this fork's `main` also triggers the repair path.

1. Pause if an open upstream-sync repair PR already exists. Require successful CI for the exact current `main` SHA; pending/missing CI means wait, not green. An existing failed baseline creates a repair PR before attempting any rebase.
2. Fetch `Rikinshah787/dotpals` `main`. If it is already an ancestor, stop without rewriting anything. Otherwise run native `git rebase --rebase-merges` on a detached copy of fork `main`, replaying fork commits, including branding/version/packaging changes. There is no automatic conflict preference such as `ours` or `theirs`.
3. A conflict aborts the rebase and leaves `main` unchanged. A draft **repair PR in this fork** contains a report commit listing the original tips, conflicted paths and workflow link. Git cannot push an unresolved index, so this PR is a repair ticket, not a falsely resolved source update. **Do not merge report-only PRs as updates.** Resolve/retest on a real repair branch and close the report PR afterward.
4. A clean rebase is pushed to a unique `automation/upstream-<run>-<attempt>` branch. The workflow explicitly calls the existing full CI workflow against that exact SHA: all Node/OS combinations, desktop, packaging and Linux-desktop tests. It does not rely on push/PR events from `GITHUB_TOKEN`, which GitHub suppresses.
   Changes to workflow files, local Actions or the privileged sync script require manual review instead: a report-only repair PR is opened without trying to publish those incoming changes. This prevents CI green from silently authorizing new privileged automation and avoids bypassing GitHub's workflow-file token restrictions.
5. Failed/cancelled/skipped CI creates a draft repair PR for that candidate, never a promotion. Fix the branch and review it normally; the bot does not auto-merge a repair PR. Open repair PRs block later automatic attempts, avoiding repeated noise or overwriting human repairs.
6. Only successful CI permits an atomic push: save the original tip as `automation/pre-rebase-<full-sha>` and update `main` using an exact `--force-with-lease`. A concurrent update to `main` or the candidate blocks promotion and opens a repair PR. No tags or releases are moved or created. GitHub protection/rules are not bypassed; refusal results in repair rather than weakening them.

Rebasing rewrites fork commit IDs. Other clones must fetch and inspect the backup branch before reconciling their own local work. Do not blindly force-push an old local `main` afterward. Backup/candidate branches are intentionally retained; remove them manually only after confirming they are no longer needed.

## Permissions and isolation

- Default workflow permissions stay read-only. Only preparation/finalization get narrowly scoped contents/PR/status permissions. The repository's Actions setting must allow creating pull requests (GitHub combines this with review approval in one setting); this bot does not approve or merge PRs.
- No PAT, stored cloud credential or new runtime dependency is used. Checkout/action revisions are pinned. Candidate CI has only read access, does not persist Git credentials and does not inherit secrets. It runs on separate runners; the privileged finalizer uses trusted workflow-commit code, not candidate artifacts or scripts.
- `workflow_run` filters accept only this fork's push CI on `main`, not external PR heads. All script entrypoints independently enforce the exact fork and `refs/heads/main`.
- Bot pushes do not start ordinary push CI. Before promotion, `fork-sync/ci` records the exact candidate SHA, successful sync run and attempt. Subsequent attempts require that exact attempt to have finished successfully, with all 13 expected reusable CI jobs successful. It is not a substitute for CI: it is written only after the explicit full CI job succeeds; API failure prevents promotion.
- A GitHub/API/token outage can also prevent creating the repair PR. In that case the Actions run fails visibly; no workflow can guarantee a PR while GitHub refuses writes. Workflow-file write restrictions or protected branches are not bypassed with elevated credentials.

## Operate or disable

- Inspect Actions → Upstream sync for the run and full candidate CI jobs. PR descriptions link to the same evidence.
- Close an obsolete repair PR after resolving its cause. The next daily/manual run checks the new baseline afresh.
- Disable Actions → Upstream sync → Disable workflow to pause automation. Existing branches and releases are unaffected. Main CI still runs normally.
- For changes to this automation, run `node --test test/upstream-sync.test.js`, the full suite, and `actionlint` on both workflow files. Unit tests use temporary local Git repositories and fake GitHub APIs; they never push or open PRs.