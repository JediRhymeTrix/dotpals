// Fork maintenance only. Candidate code runs in separate read-only CI jobs, never here.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = 'JediRhymeTrix/dotpals';
const UPSTREAM = 'https://github.com/Rikinshah787/dotpals.git';
const MARKER = '<!-- fork-upstream-sync -->';
const CI_JOBS = [
  ...[20, 22].flatMap((node) => ['ubuntu', 'windows', 'macos'].map((os) => `Node ${node} on ${os}-latest`)),
  ...['ubuntu', 'windows', 'macos'].map((os) => `Desktop app on ${os}-latest`),
  'Packaged app (.dmg) on macos-latest', 'Packaged app (.exe) on windows-latest', 'Packaged app (.AppImage) on ubuntu-latest', "Blu's hands on a Linux desktop",
];
const sha = (s) => /^[a-f0-9]{40}$/.test(s ?? '');
const identity = (e) => `${e.GITHUB_RUN_ID}-${e.GITHUB_RUN_ATTEMPT}`;
const runUrl = (e) => `https://github.com/${REPO}/actions/runs/${e.GITHUB_RUN_ID}`;
const command = (cwd) => (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function trusted(env) {
  if (env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== 'refs/heads/main' || !/^\d+-\d+$/.test(identity(env))) throw new Error('Fork/main/run identity required');
}

export function attemptRebase({ cwd, base, upstream }) {
  const git = command(cwd);
  if (!sha(base) || !sha(upstream)) throw new Error('Invalid commit SHA');
  if (git('status', '--porcelain')) throw new Error('A clean worktree is required');
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', upstream, base], { cwd });
  if (ancestor.status === 0) return { state: 'unchanged' };
  if (ancestor.status !== 1) throw new Error('Could not determine upstream ancestry');
  git('checkout', '--detach', base);
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'rerere.enabled=false', 'rebase', '--rebase-merges', upstream], { cwd, encoding: 'utf8' });
  if (result.status === 0) return { state: 'candidate', sha: git('rev-parse', 'HEAD') };
  const conflicts = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  git('rebase', '--abort');
  return { state: 'conflict', conflicts, detail: 'Native git rebase stopped; no automatic conflict resolution was applied.' };
}

export function automationChanges(git, base, candidate) {
  return git('diff', '--name-only', base, candidate, '--', '.github/workflows', '.github/actions', 'scripts/upstream-sync.mjs').split('\n').filter(Boolean);
}

function github(env) {
  const api = (path, method = 'GET', body) => {
    const args = ['api', `repos/${REPO}${path}`, '--method', method];
    if (body) args.push('--input', '-');
    const text = execFileSync('gh', args, { env, input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return text.trim() ? JSON.parse(text) : null;
  };
  return { api, list: async (path) => {
    const all = [];
    for (let page = 1; ; page++) {
      const answer = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = Array.isArray(answer) ? answer : answer.workflow_runs ?? answer.jobs;
      if (!Array.isArray(rows)) throw new Error('Unexpected GitHub list response');
      all.push(...rows);
      if (rows.length < 100) return all;
    }
  } };
}

export async function baseline(gh, base) {
  const runs = (await gh.list(`/actions/workflows/ci.yml/runs?head_sha=${base}&branch=main&event=push`))
    .filter((r) => r.head_sha === base && r.head_branch === 'main').sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  if (runs.length) return runs[0].status !== 'completed' ? 'pending' : runs[0].conclusion === 'success' ? 'green' : 'failed';
  // GITHUB_TOKEN pushes do not trigger push CI. Only our own validated sync run can attest that base.
  const status = (await gh.list(`/commits/${base}/statuses`)).find((s) => s.context === 'fork-sync/ci');
  const match = new RegExp(`^https://github.com/${REPO}/actions/runs/(\\d+)/attempts/(\\d+)$`).exec(status?.target_url ?? '');
  if (status?.state !== 'success' || status.creator?.login !== 'github-actions[bot]' || !match || status.description !== `Validated ${base} attempt ${match[2]}`) return 'pending';
  const path = `/actions/runs/${match[1]}/attempts/${match[2]}`;
  const run = await gh.api(path);
  if (run.path !== '.github/workflows/upstream-sync.yml' || run.status !== 'completed' || run.conclusion !== 'success' || run.run_attempt !== Number(match[2]) || run.repository?.full_name !== REPO || !['schedule', 'workflow_dispatch', 'workflow_run'].includes(run.event)) return 'pending';
  const jobs = await gh.list(`${path}/jobs`);
  return CI_JOBS.every((name) => jobs.some((j) => j.name === `ci / ${name}` && j.status === 'completed' && j.conclusion === 'success')) ? 'green' : 'pending';
}

export async function report({ gh, env, branch, reason, base, upstream, conflicts = [] }) {
  if (!/^automation\/upstream-\d+-\d+(?:-report)?$/.test(branch)) throw new Error('Invalid report branch');
  const body = `${MARKER}\n## What does this change?\n\nUpstream sync requires human repair: **${reason}**. Automatic repair is paused. Inspect the run and current main tip before acting; a lost push response can be ambiguous.\n\n- Fork base: \`${base}\`\n- Upstream: \`${upstream ?? 'not fetched'}\`\n- [Attempt and CI logs](${runUrl(env)})\n${conflicts.length ? `\nPaths requiring review:\n${conflicts.map((p) => `- ${JSON.stringify(p)}`).join('\n')}\n` : ''}\nA conflict report branch contains only this report, not a falsely resolved rebase. Reproduce on a disposable branch with git rebase --rebase-merges, resolve and run full CI. A CI-failure branch contains the candidate needing repair. Do not merge a report-only PR as a source update.\n\n## How did you test it?\n\nSee the linked workflow; this PR is not auto-merged.\n\n## Checklist\n\n- [ ] Conflicts resolved and full CI passes\n- [ ] Fork branding/version changes preserved\n- [ ] Human reviewed before merge\n`;
  const existing = (await gh.list('/pulls?state=open&base=main')).find((p) => p.head.ref === branch);
  const data = { title: `Repair upstream sync: ${reason}`.slice(0, 200), body };
  return existing ? gh.api(`/pulls/${existing.number}`, 'PATCH', data) : gh.api('/pulls', 'POST', { ...data, head: branch, base: 'main', draft: true });
}

function reportCommit({ git, env, base, reason, upstream, conflicts }) {
  git('checkout', '--detach', base);
  const file = `.github/upstream-sync/${identity(env)}.md`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# Upstream sync needs repair\n\n${reason}\n\nBase: ${base}\nUpstream: ${upstream ?? 'unknown'}\nRun: ${runUrl(env)}\n\nConflicts: ${JSON.stringify(conflicts ?? [])}\n\nReport only; source remains unchanged. Do not merge as an upstream update.\n`);
  git('add', '--', file); git('commit', '-m', `Record upstream sync repair needed (${identity(env)})`);
  return git('rev-parse', 'HEAD');
}

function output(env, data) {
  if (env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(data)) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function prepare({ env, gh, git }) {
  trusted(env);
  let base = git('rev-parse', 'HEAD');
  const branch = `automation/upstream-${identity(env)}`;
  let upstream, reason, conflicts;
  try {
    git('fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main');
    base = git('rev-parse', 'refs/remotes/origin/main');
    if ((await gh.list('/pulls?state=open&base=main')).some((p) => p.head.ref.startsWith('automation/upstream-') || p.body?.includes(MARKER))) return output(env, { state: 'blocked' });
    const green = await baseline(gh, base);
    if (green === 'pending') return output(env, { state: 'waiting-for-baseline' });
    if (green === 'failed') reason = 'Current main CI failed';
    else {
      git('fetch', '--no-tags', UPSTREAM, 'refs/heads/main:refs/remotes/upstream/main');
      upstream = git('rev-parse', 'refs/remotes/upstream/main');
      const got = attemptRebase({ cwd: process.cwd(), base, upstream });
      if (got.state === 'unchanged') return output(env, { state: 'unchanged' });
      if (got.state === 'conflict') { reason = 'Rebase conflicts'; conflicts = got.conflicts; }
      else if ((conflicts = automationChanges(git, base, got.sha)).length) reason = 'Automation changes need manual review';
      else {
        git('push', 'origin', `${got.sha}:refs/heads/${branch}`);
        return output(env, { state: 'candidate', base, upstream, sha: got.sha, branch });
      }
    }
  } catch (err) {
    // Do not put raw command stderr (which may contain URLs/credentials) into public reports.
    console.error('Upstream preparation failed; see this job for the failed command.');
    reason = 'Rebase preparation failed';
  }
  const commit = reportCommit({ git, env, base, upstream, reason, conflicts });
  git('push', 'origin', `${commit}:refs/heads/${branch}`);
  await report({ gh, env, base, upstream, branch, reason, conflicts });
  output(env, { state: 'repair-pr' });
}

export async function finish({ env, gh, git, state, result }) {
  trusted(env);
  const { base, sha: candidate, branch, upstream } = state;
  if (![base, candidate, upstream].every(sha) || branch !== `automation/upstream-${identity(env)}`) throw new Error('Invalid candidate identity');
  git('fetch', '--no-tags', 'origin', `refs/heads/main:refs/remotes/origin/main`, `refs/heads/${branch}:refs/remotes/origin/candidate`);
  if (git('rev-parse', 'refs/remotes/origin/main') !== base || git('rev-parse', 'refs/remotes/origin/candidate') !== candidate) throw new Error('Main or candidate changed; refusing promotion');
  if (result !== 'success') return report({ gh, env, branch, base, upstream, reason: `Candidate CI ${result}` });
  if ((await gh.list('/pulls?state=open&base=main')).some((p) => p.head.ref.startsWith('automation/upstream-'))) throw new Error('Repair PR opened while CI ran; main changed eligibility');
  // Write the attestation first: its linked run must also finish successfully before it can be reused.
  // An API failure here must not leave main promoted without recorded CI evidence.
  await gh.api(`/statuses/${candidate}`, 'POST', { state: 'success', context: 'fork-sync/ci', description: `Validated ${candidate} attempt ${env.GITHUB_RUN_ATTEMPT}`, target_url: `${runUrl(env)}/attempts/${env.GITHUB_RUN_ATTEMPT}` });
  // One transaction: backup old tip and replace main only if it still equals the tested base.
  git('push', '--atomic', `--force-with-lease=refs/heads/main:${base}`, `--force-with-lease=refs/heads/automation/pre-rebase-${base}:`, 'origin', `${base}:refs/heads/automation/pre-rebase-${base}`, `${candidate}:refs/heads/main`);
}

async function main(env) {
  trusted(env);
  const git = command(process.cwd()), gh = github(env);
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  if (process.argv[2] === 'prepare') return prepare({ env, git, gh });
  if (process.argv[2] !== 'finish') throw new Error('Expected prepare or finish');
  const state = { base: env.SYNC_BASE, upstream: env.SYNC_UPSTREAM, sha: env.SYNC_SHA, branch: env.SYNC_BRANCH };
  try { await finish({ env, git, gh, state, result: env.SYNC_CI_RESULT }); }
  catch (err) {
    // A concurrent update may already contain the candidate, leaving no PR diff. Always create a fresh report off current main.
    git('fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main');
    const base = git('rev-parse', 'refs/remotes/origin/main');
    const reason = 'Promotion blocked or failed';
    const commit = reportCommit({ git, env, base, upstream: state.upstream, reason });
    const branch = `${state.branch}-report`;
    git('push', 'origin', `${commit}:refs/heads/${branch}`);
    await report({ gh, env, ...state, base, branch, reason });
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env).catch(() => {
  const note = 'Upstream sync failed. Main promotion is never retried blindly; inspect logs and remote tips. GitHub/API denial may also prevent the repair PR.\n';
  console.error(note);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, note);
  process.exitCode = 1;
});