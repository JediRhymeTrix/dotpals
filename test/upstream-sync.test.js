import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptRebase, automationChanges, baseline, finish, report, trusted } from '../scripts/upstream-sync.mjs';

const SHA = 'a'.repeat(40), NEXT = 'b'.repeat(40), UP = 'c'.repeat(40);
const env = { GITHUB_REPOSITORY: 'JediRhymeTrix/dotpals', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SERVER_URL: 'https://github.com' };

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dotpals-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Sync test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(dir, 'shared.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  return { dir, git, base, commit(file, body, message) { writeFileSync(join(dir, file), body); git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); } };
}

test('rebase preserves fork changes on top of new upstream commits', (t) => {
  const r = repo(t);
  const fork = r.commit('branding.txt', 'fork\n', 'fork branding');
  r.git('checkout', '-b', 'upstream', r.base);
  const upstream = r.commit('new.txt', 'upstream\n', 'upstream addition');
  r.git('checkout', 'main');
  const got = attemptRebase({ cwd: r.dir, base: fork, upstream });
  assert.equal(got.state, 'candidate');
  assert.equal(r.git('merge-base', got.sha, upstream), upstream);
  assert.equal(r.git('show', `${got.sha}:branding.txt`), 'fork');
  assert.equal(r.git('rev-parse', 'main'), fork, 'never moves main while preparing');
  assert.equal(r.git('status', '--porcelain'), '');
});

test('conflict aborts rebase, preserves main and reports paths without markers', (t) => {
  const r = repo(t);
  const fork = r.commit('shared.txt', 'fork\n', 'fork edit');
  r.git('checkout', '-b', 'upstream', r.base);
  const upstream = r.commit('shared.txt', 'upstream\n', 'upstream edit');
  r.git('checkout', 'main');
  const got = attemptRebase({ cwd: r.dir, base: fork, upstream });
  assert.equal(got.state, 'conflict');
  assert.deepEqual(got.conflicts, ['shared.txt']);
  assert.equal(r.git('rev-parse', 'main'), fork);
  assert.equal(r.git('rev-parse', 'HEAD'), fork);
  assert.equal(readFileSync(join(r.dir, 'shared.txt'), 'utf8'), 'fork\n');
  assert.equal(r.git('status', '--porcelain'), '');
});

test('no upstream change needs no rebase; dirty worktree is rejected', (t) => {
  const r = repo(t);
  const fork = r.commit('branding.txt', 'fork\n', 'fork branding');
  assert.equal(attemptRebase({ cwd: r.dir, base: fork, upstream: r.base }).state, 'unchanged');
  writeFileSync(join(r.dir, 'shared.txt'), 'dirty');
  assert.throws(() => attemptRebase({ cwd: r.dir, base: fork, upstream: r.base }), /clean/);
});

test('rebase retains merge commits and both feature lines', (t) => {
  const r = repo(t);
  r.git('checkout', '-b', 'feature');
  r.commit('feature.txt', 'feature\n', 'feature work');
  r.git('checkout', 'main');
  r.commit('branding.txt', 'fork\n', 'fork branding');
  r.git('merge', '--no-ff', 'feature', '-m', 'keep feature merge');
  const fork = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-b', 'upstream', r.base);
  const upstream = r.commit('upstream.txt', 'upstream\n', 'upstream work');
  r.git('checkout', 'main');
  const got = attemptRebase({ cwd: r.dir, base: fork, upstream });
  assert.equal(got.state, 'candidate');
  assert.equal(r.git('rev-list', '--count', '--merges', `${upstream}..${got.sha}`), '1');
  assert.equal(r.git('show', `${got.sha}:feature.txt`), 'feature');
  assert.equal(r.git('show', `${got.sha}:branding.txt`), 'fork');
  assert.equal(r.git('rev-parse', 'main'), fork);
});

test('automation rejects another repository, branch and malformed run identity', () => {
  assert.doesNotThrow(() => trusted(env));
  for (const patch of [{ GITHUB_REPOSITORY: 'Rikinshah787/dotpals' }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_RUN_ID: '../x' }]) assert.throws(() => trusted({ ...env, ...patch }));
});

test('incoming automation changes require manual review, not automatic promotion', () => {
  let args;
  const paths = automationChanges((...a) => { args = a; return '.github/workflows/ci.yml\nscripts/upstream-sync.mjs'; }, SHA, NEXT);
  assert.deepEqual(paths, ['.github/workflows/ci.yml', 'scripts/upstream-sync.mjs']);
  assert.deepEqual(args, ['diff', '--name-only', SHA, NEXT, '--', '.github/workflows', '.github/actions', 'scripts/upstream-sync.mjs']);
  assert.deepEqual(automationChanges(() => '', SHA, NEXT), []);
});

test('baseline requires the latest exact-SHA CI, not an older pass or a different commit', async () => {
  const run = { head_sha: SHA, head_branch: 'main', status: 'completed', conclusion: 'success', run_number: 1 };
  const gh = { list: async () => [run] };
  assert.equal(await baseline(gh, SHA), 'green');
  gh.list = async () => [{ ...run, run_number: 2, conclusion: 'failure' }, run];
  assert.equal(await baseline(gh, SHA), 'failed');
  gh.list = async () => [{ ...run, status: 'in_progress', conclusion: null }];
  assert.equal(await baseline(gh, SHA), 'pending');
  gh.list = async () => [{ ...run, head_sha: NEXT }];
  assert.equal(await baseline(gh, SHA), 'pending');
});

test('a bot-published base requires an exact commit status and completed successful sync run', async () => {
  const status = { context: 'fork-sync/ci', state: 'success', creator: { login: 'github-actions[bot]' }, description: `Validated ${SHA} attempt 1`, target_url: 'https://github.com/JediRhymeTrix/dotpals/actions/runs/122/attempts/1' };
  let check = { path: '.github/workflows/upstream-sync.yml', status: 'completed', conclusion: 'success', run_attempt: 1, event: 'schedule', repository: { full_name: env.GITHUB_REPOSITORY } };
  const names = [...[20, 22].flatMap((n) => ['ubuntu', 'windows', 'macos'].map((os) => `Node ${n} on ${os}-latest`)), ...['ubuntu', 'windows', 'macos'].map((os) => `Desktop app on ${os}-latest`), 'Packaged app (.dmg) on macos-latest', 'Packaged app (.exe) on windows-latest', 'Packaged app (.AppImage) on ubuntu-latest', "Blu's hands on a Linux desktop"];
  const jobs = names.map((name) => ({ name: `ci / ${name}`, status: 'completed', conclusion: 'success' }));
  const gh = { list: async (path) => path.includes('/statuses') ? [status] : path.endsWith('/jobs') ? jobs : [], api: async () => check };
  assert.equal(await baseline(gh, SHA), 'green');
  check = { ...check, conclusion: 'failure' };
  assert.equal(await baseline(gh, SHA), 'pending');
  check.conclusion = 'success'; jobs[0].conclusion = 'skipped';
  assert.equal(await baseline(gh, SHA), 'pending');
  jobs[0].conclusion = 'success'; status.creator.login = 'someone';
  assert.equal(await baseline(gh, SHA), 'pending');
});

test('baseline does not accept an unrelated sync workflow URL or path', async () => {
  const status = { context: 'fork-sync/ci', state: 'success', creator: { login: 'github-actions[bot]' }, target_url: 'https://github.com/elsewhere/repo/actions/runs/122' };
  const gh = { list: async (p) => p.includes('/statuses') ? [status] : [], api: async () => ({ path: 'other.yml', status: 'completed', conclusion: 'success' }) };
  assert.equal(await baseline(gh, SHA), 'pending');
  status.target_url = 'https://github.com/JediRhymeTrix/dotpals/actions/runs/122';
  assert.equal(await baseline(gh, SHA), 'pending');
});

test('successful CI promotes only the exact tested candidate with backup and an exact main lease', async () => {
  const calls = [];
  const git = (...args) => { calls.push(args); if (args[0] === 'rev-parse') return args[1].includes('main') ? SHA : NEXT; return ''; };
  const gh = { list: async () => [], api: async (...a) => calls.push(a) };
  await finish({ env, git, gh, state: { base: SHA, upstream: UP, sha: NEXT, branch: 'automation/upstream-123-1' }, result: 'success' });
  const push = calls.find((c) => c[0] === 'push');
  assert.ok(push.includes('--atomic'));
  assert.ok(push.includes(`--force-with-lease=refs/heads/main:${SHA}`));
  assert.ok(push.includes(`--force-with-lease=refs/heads/automation/pre-rebase-${SHA}:`));
  assert.ok(push.includes(`${SHA}:refs/heads/automation/pre-rebase-${SHA}`));
  assert.ok(push.includes(`${NEXT}:refs/heads/main`));
});

test('CI failure opens a draft fork PR but never pushes main; repeated reports update the existing PR', async () => {
  const calls = [];
  const git = (...args) => { calls.push(args); if (args[0] === 'rev-parse') return args[1].includes('main') ? SHA : NEXT; return ''; };
  const gh = { list: async () => [], api: async (...a) => { calls.push(a); return { html_url: 'https://github.com/JediRhymeTrix/dotpals/pull/1' }; } };
  await finish({ env, git, gh, state: { base: SHA, upstream: UP, sha: NEXT, branch: 'automation/upstream-123-1' }, result: 'failure' });
  assert.ok(!calls.some((c) => c[0] === 'push' && c.some((a) => String(a).endsWith(':refs/heads/main'))));
  const pr = calls.find((c) => c[0] === '/pulls' && c[1] === 'POST')[2];
  assert.equal(pr.base, 'main'); assert.equal(pr.draft, true); assert.match(pr.body, /CI.*failure/);
  calls.length = 0;
  gh.list = async () => [{ number: 1, head: { ref: 'automation/upstream-123-1' }, body: '<!-- fork-upstream-sync -->' }];
  await report({ gh, env, branch: 'automation/upstream-123-1', reason: 'CI failure', base: SHA, upstream: UP });
  assert.ok(calls.some((c) => c[0] === '/pulls/1' && c[1] === 'PATCH'));
});

test('candidate tampering and concurrent main changes cannot be promoted', async () => {
  for (const changed of ['main', 'candidate']) {
    const calls = [];
    const git = (...args) => { calls.push(args); if (args[0] === 'rev-parse') return args[1].includes('main') ? (changed === 'main' ? UP : SHA) : (changed === 'candidate' ? UP : NEXT); return ''; };
    const gh = { list: async () => [], api: async () => ({}) };
    await assert.rejects(finish({ env, git, gh, state: { base: SHA, upstream: UP, sha: NEXT, branch: 'automation/upstream-123-1' }, result: 'success' }), /changed/);
    assert.ok(!calls.some((c) => c[0] === 'push'));
  }
});

test('unknown CI results and active repair PRs never promote main', async () => {
  for (const result of ['cancelled', 'skipped', 'failure', '']) {
    const calls = [];
    const git = (...args) => { calls.push(args); return args[0] === 'rev-parse' ? (args[1].includes('main') ? SHA : NEXT) : ''; };
    const gh = { list: async () => [], api: async () => ({}) };
    await finish({ env, gh, git, state: { base: SHA, upstream: UP, sha: NEXT, branch: 'automation/upstream-123-1' }, result });
    assert.ok(!calls.some((a) => a[0] === 'push'));
  }
  const calls = [];
  const git = (...args) => { calls.push(args); return args[0] === 'rev-parse' ? (args[1].includes('main') ? SHA : NEXT) : ''; };
  const gh = { list: async () => [{ head: { ref: 'automation/upstream-122-1' } }], api: async () => ({}) };
  await assert.rejects(finish({ env, gh, git, state: { base: SHA, upstream: UP, sha: NEXT, branch: 'automation/upstream-123-1' }, result: 'success' }), /Repair PR/);
  assert.ok(!calls.some((a) => a[0] === 'push'));
});

test('failed CI attestation write cannot promote main', async () => {
  const calls = [];
  const git = (...args) => { calls.push(args); return args[0] === 'rev-parse' ? (args[1].includes('main') ? SHA : NEXT) : ''; };
  const gh = { list: async () => [], api: async () => { throw new Error('GitHub unavailable'); } };
  await assert.rejects(finish({ env, gh, git, state: { base: SHA, upstream: UP, sha: NEXT, branch: 'automation/upstream-123-1' }, result: 'success' }), /unavailable/);
  assert.ok(!calls.some((a) => a[0] === 'push'));
});

test('workflow structure keeps candidate execution read-only and checks out the exact SHA everywhere', () => {
  const workflow = readFileSync(new URL('../.github/workflows/upstream-sync.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '23 6 \* \* \*'/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
  const called = workflow.split('\n  ci:\n')[1].split('\n  finish:\n')[0];
  assert.match(called, /contents: read/);
  assert.doesNotMatch(called, /secrets:|write|GH_TOKEN/);
  assert.equal((ci.match(/uses: actions\/checkout@/g) ?? []).length, 4);
  assert.equal((ci.match(/ref: \$\{\{ inputs\.checkout-ref \|\| github\.sha \}\}/g) ?? []).length, 4);
  assert.equal((ci.match(/persist-credentials: false/g) ?? []).length, 4);
  assert.match(workflow, /cancel-in-progress: false/);
});