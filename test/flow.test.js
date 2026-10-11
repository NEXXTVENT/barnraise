import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../src/db.js';
import { Coordinator, TaskError, parsePrUrl } from '../src/coordinator.js';
import { parseConfig, verifySignature } from '../src/github.js';
import { handleWebhook } from '../src/webhooks.js';
import { createApp } from '../src/server.js';

const REPO = 'acme/widgets';

function fakeGithub(pulls = {}) {
  const comments = [];
  return {
    comments,
    pulls,
    config: {},
    async getPull(repo, _installation, number) {
      return pulls[`${repo}#${number}`] ?? null;
    },
    async comment(repo, _installation, number, body) {
      comments.push({ repo, number, body });
    },
    async getConfig() {
      return this.config;
    },
    issues: [],
    async createIssue(repo, _installation, issue) {
      const number = 100 + this.issues.push({ repo, ...issue });
      return { number };
    },
  };
}

function setup() {
  const github = fakeGithub();
  const clock = { t: 1_000_000 };
  const coordinator = new Coordinator({ db: openDb(), github, now: () => clock.t });
  return { github, clock, coordinator };
}

const labeled = (number, title = `Fix thing ${number}`) => ({
  action: 'labeled',
  label: { name: 'barnraise' },
  installation: { id: 7 },
  repository: { full_name: REPO },
  issue: { number, title, body: 'It is broken.', state: 'open', labels: [{ name: 'barnraise' }] },
});

test('labelling an issue creates one task and one comment', async () => {
  const { coordinator, github } = setup();
  await handleWebhook(coordinator, github, 'issues', labeled(1));
  await handleWebhook(coordinator, github, 'issues', { ...labeled(1), action: 'edited', label: undefined });
  assert.equal(coordinator.state().tasks.length, 1);
  assert.equal(github.comments.length, 1);
  assert.equal(coordinator.project(REPO).installation_id, 7);
});

test('other labels and pull requests are ignored', async () => {
  const { coordinator, github } = setup();
  await handleWebhook(coordinator, github, 'issues', { ...labeled(1), label: { name: 'bug' } });
  const pr = labeled(2);
  pr.issue.pull_request = {};
  await handleWebhook(coordinator, github, 'issues', pr);
  assert.equal(coordinator.state().tasks.length, 0);
});

test('full flow: claim, submit, review, merge', async () => {
  const { coordinator, github } = setup();
  await handleWebhook(coordinator, github, 'issues', labeled(1));
  coordinator.issueToken('alice');
  coordinator.issueToken('bob');

  const task = coordinator.claim('alice');
  assert.equal(task.kind, 'build');
  assert.equal(coordinator.claim('alice').id, task.id, 'claiming again returns the held task');
  assert.throws(() => coordinator.claim('bob'), TaskError, 'nothing left for bob');

  github.pulls[`${REPO}#10`] = { state: 'open', user: { login: 'Alice' }, html_url: `https://github.com/${REPO}/pull/10` };
  await coordinator.submit('alice', task.id, `https://github.com/${REPO}/pull/10`);
  assert.equal(coordinator.task(task.id).status, 'submitted');

  assert.throws(() => coordinator.claim('alice'), TaskError, 'authors cannot review their own pull request');
  const review = coordinator.claim('bob');
  assert.equal(review.kind, 'review');
  await coordinator.submitReview('bob', review.id, 'approve', 'Small focused change with a test.');
  assert.equal(github.comments.at(-1).number, 10);
  assert.match(github.comments.at(-1).body, /Looks good/);

  await handleWebhook(coordinator, github, 'pull_request', {
    action: 'closed',
    repository: { full_name: REPO },
    pull_request: { number: 10, merged: true },
  });
  assert.equal(coordinator.task(task.id).status, 'merged');
  assert.deepEqual(coordinator.state().leaderboard.map((row) => ({ ...row })), [
    { login: 'alice', merged: 1, reviews: 0, plans: 0 },
    { login: 'bob', merged: 0, reviews: 1, plans: 0 },
  ]);
});

test('a pull request from another account or repo is rejected', async () => {
  const { coordinator, github } = setup();
  await handleWebhook(coordinator, github, 'issues', labeled(1));
  const task = coordinator.claim('alice');
  github.pulls[`${REPO}#11`] = { state: 'open', user: { login: 'mallory' } };
  await assert.rejects(coordinator.submit('alice', task.id, `https://github.com/${REPO}/pull/11`), /opened by mallory/);
  await assert.rejects(coordinator.submit('alice', task.id, 'https://github.com/other/repo/pull/11'), /must be opened against/);
  await assert.rejects(coordinator.submit('alice', task.id, `https://github.com/${REPO}/pull/99`), /Could not find/);
  assert.throws(() => parsePrUrl('https://example.com/x'), TaskError);
});

test('the per-repo cap limits work in flight', async () => {
  const { coordinator, github } = setup();
  github.config = { max_open_prs: 1 };
  await handleWebhook(coordinator, github, 'issues', labeled(1));
  await handleWebhook(coordinator, github, 'issues', labeled(2));
  coordinator.claim('alice');
  assert.throws(() => coordinator.claim('bob'), /No tasks are available/);
});

test('leases expire and closed pull requests reopen the task', async () => {
  const { coordinator, github, clock } = setup();
  await handleWebhook(coordinator, github, 'issues', labeled(1));
  const task = coordinator.claim('alice');
  clock.t += 3 * 60 * 60 * 1000;
  assert.equal(coordinator.claim('bob').id, task.id, 'bob gets it after the lease runs out');
  assert.throws(() => coordinator.release('alice', task.id), TaskError);

  github.pulls[`${REPO}#12`] = { state: 'open', user: { login: 'bob' } };
  await coordinator.submit('bob', task.id, `https://github.com/${REPO}/pull/12`);
  coordinator.onPullClosed(REPO, 12, false);
  assert.equal(coordinator.task(task.id).status, 'open');
  assert.equal(coordinator.state().tasks.filter((t) => t.kind === 'review').length, 0, 'its review task is closed');
});

test('removing the label closes the task', async () => {
  const { coordinator, github } = setup();
  await handleWebhook(coordinator, github, 'issues', labeled(1));
  await handleWebhook(coordinator, github, 'issues', { ...labeled(1), action: 'unlabeled' });
  assert.equal(coordinator.state().tasks.length, 0);
});

test('config parsing and webhook signatures', () => {
  assert.deepEqual(parseConfig('max_open_prs: 3\ntest_command: "npm test"\n# x\nother: 1\nnotes: Keep it small.'), {
    max_open_prs: 3,
    test_command: 'npm test',
    notes: 'Keep it small.',
  });
  const body = Buffer.from('{"a":1}');
  const good = 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(verifySignature('s3cret', body, good), true);
  assert.equal(verifySignature('s3cret', body, good.replace(/.$/, '0')), false);
  assert.equal(verifySignature(undefined, body, good), false);
});

test('an agent can work through the server over MCP', async (t) => {
  const github = fakeGithub();
  const { server, coordinator } = createApp({ dev: true, github, publicUrl: 'http://localhost' });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;

  const hook = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'x-github-event': 'issues', 'content-type': 'application/json' },
    body: JSON.stringify(labeled(5, 'Typo in README')),
  });
  assert.equal(hook.status, 200);

  const unauth = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);

  const joined = await (await fetch(`${base}/auth/dev?login=alice`)).text();
  const token = /Bearer (brz_[0-9a-f]+)/.exec(joined)[1];

  const client = new Client({ name: 'test-agent', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
  );
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ['back_proposal', 'claim_task', 'list_proposals', 'list_tasks', 'release_task', 'submit_plan', 'submit_review', 'submit_task', 'withdraw_backing']);

  const claimed = await client.callTool({ name: 'claim_task', arguments: {} });
  const instructions = claimed.content[0].text;
  assert.match(instructions, /issue #5, "Typo in README"/);
  assert.match(instructions, /Closes #5/);
  assert.match(instructions, /checked by @alice/);
  const taskId = Number(/Task #(\d+)/.exec(instructions)[1]);

  const wrong = await client.callTool({ name: 'submit_task', arguments: { task_id: taskId, pr_url: `https://github.com/${REPO}/pull/3` } });
  assert.equal(wrong.isError, true);

  github.pulls[`${REPO}#3`] = { state: 'open', user: { login: 'alice' }, html_url: `https://github.com/${REPO}/pull/3` };
  const ok = await client.callTool({ name: 'submit_task', arguments: { task_id: taskId, pr_url: `https://github.com/${REPO}/pull/3` } });
  assert.ok(!ok.isError);
  assert.equal(coordinator.task(taskId).status, 'submitted');

  const home = await (await fetch(base)).text();
  assert.match(home, /in review/);
});

test('GET /health answers ok', async (t) => {
  const { server } = createApp({ github: fakeGithub(), publicUrl: 'http://localhost' });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const res = await fetch(`http://localhost:${server.address().port}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('GET /api/version reports the package version', async (t) => {
  const { server } = createApp({ github: fakeGithub(), publicUrl: 'http://localhost' });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const res = await fetch(`http://localhost:${server.address().port}/api/version`);
  assert.equal(res.status, 200);
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(await res.json(), { version });
});

const proposed = (number, title = `Feature ${number}`) => ({
  action: 'labeled',
  label: { name: 'barnraise-proposal' },
  installation: { id: 7 },
  repository: { full_name: REPO },
  issue: { number, title, body: '', state: 'open', labels: [{ name: 'barnraise-proposal' }] },
});

test('volunteers back a proposal, the maintainer approves, backers go first', async () => {
  const { coordinator, github, clock } = setup();
  github.config = { proposal_threshold: 2 };
  await handleWebhook(coordinator, github, 'issues', proposed(20, 'Dark mode'));
  await handleWebhook(coordinator, github, 'issues', proposed(21, 'Plugin system'));
  assert.equal(coordinator.state().tasks.length, 0, 'a proposal is not work yet');
  const [dark, plugins] = coordinator.proposals();

  await coordinator.back('alice', plugins.id);
  await coordinator.back('alice', dark.id);
  assert.equal(coordinator.proposals().find((p) => p.id === plugins.id).backers, 0, 'backing another proposal moves the pledge');
  assert.equal(github.comments.length, 0);

  const ready = await coordinator.back('bob', dark.id);
  assert.equal(ready.status, 'ready');
  assert.match(github.comments.at(-1).body, /2 Barnraise volunteers have pledged/);
  await coordinator.back('bob', dark.id);
  assert.equal(github.comments.length, 1, 'the maintainers are only pinged once');

  const approve = labeled(20, 'Dark mode');
  approve.issue.labels.push({ name: 'barnraise-proposal' });
  await handleWebhook(coordinator, github, 'issues', approve);
  assert.equal(coordinator.proposals().length, 1, 'the approved proposal leaves the poll');

  assert.throws(() => coordinator.claim('carol'), /No tasks/, 'non-backers wait');
  clock.t += 49 * 60 * 60 * 1000;
  assert.equal(coordinator.claimable('carol').length, 1, 'after the priority window anyone can take it');
  assert.equal(coordinator.claim('alice').issue_number, 20);
});

test('declining a proposal drops its pledges', async () => {
  const { coordinator, github } = setup();
  await handleWebhook(coordinator, github, 'issues', proposed(30));
  const [p] = coordinator.proposals();
  await coordinator.back('alice', p.id);
  await handleWebhook(coordinator, github, 'issues', { ...proposed(30), action: 'unlabeled' });
  assert.equal(coordinator.proposals().length, 0);
  assert.equal(coordinator.hasBacked('alice', p.id), false);
  await assert.rejects(coordinator.back('alice', p.id), /not open for backing/);
});

const opened = (number, login, { body = '', branch = 'patch-1' } = {}) => ({
  action: 'opened',
  repository: { full_name: REPO },
  pull_request: { number, html_url: `https://github.com/${REPO}/pull/${number}`, user: { login }, body, head: { ref: branch } },
});

test('an opened pull request is recorded without the volunteer reporting it', async () => {
  const { coordinator, github } = setup();
  await handleWebhook(coordinator, github, 'issues', labeled(1));
  const task = coordinator.claim('alice');
  await assert.rejects(coordinator.submit('alice', task.id), /No pull request has been seen/);

  await handleWebhook(coordinator, github, 'pull_request', opened(40, 'mallory', { body: `Barnraise task #${task.id}.` }));
  await handleWebhook(coordinator, github, 'pull_request', opened(41, 'alice', { body: 'Unrelated work' }));
  await handleWebhook(coordinator, github, 'pull_request', opened(42, 'alice', { body: `Barnraise task #${task.id}0.` }));
  assert.equal(coordinator.task(task.id).status, 'claimed', 'only the holder\'s pull request for this task counts');

  await handleWebhook(coordinator, github, 'pull_request', opened(43, 'Alice', { body: `Closes #1\n\nBarnraise task #${task.id}. Written with AI assistance.` }));
  const recorded = coordinator.task(task.id);
  assert.equal(recorded.status, 'submitted');
  assert.equal(recorded.pr_number, 43);
  assert.equal((await coordinator.submit('alice', task.id)).pr_number, 43, 'confirming afterwards needs no URL');
  assert.equal(coordinator.claim('bob').kind, 'review');
});

test('the branch name alone is enough to match a pull request', async () => {
  const { coordinator, github } = setup();
  await handleWebhook(coordinator, github, 'issues', labeled(7, 'Fix the Thing!'));
  const task = coordinator.claim('alice');
  await handleWebhook(coordinator, github, 'pull_request', opened(50, 'alice', { branch: 'barnraise/7-fix-the-thing' }));
  assert.equal(coordinator.task(task.id).status, 'submitted');
});

test('task steps include a prefilled pull request link', async () => {
  const { describeTask } = await import('../src/mcp.js');
  const { coordinator, github } = setup();
  await handleWebhook(coordinator, github, 'issues', labeled(7, 'Fix the Thing!'));
  const steps = describeTask(coordinator.claim('alice'), coordinator.project(REPO), 'alice');
  const link = new URL(/https:\/\/github\.com\/\S+quick_pull=1\S*/.exec(steps)[0]);
  assert.equal(link.pathname, `/${REPO}/compare/alice:barnraise/7-fix-the-thing`);
  assert.equal(link.searchParams.get('title'), 'Fix the Thing!');
  assert.match(link.searchParams.get('body'), /^Closes #7\n\nBarnraise task #1\. Written with AI assistance and checked by @alice\.$/);
});

const planLabeled = (number, title = 'Big feature') => ({
  action: 'labeled',
  label: { name: 'barnraise-plan' },
  installation: { id: 7 },
  repository: { full_name: REPO },
  issue: { number, title, body: 'Lots to do.', state: 'open', labels: [{ name: 'barnraise-plan' }] },
});

const SUBTASKS = [
  { title: 'Add the settings table', description: 'Create the table in src/db.js with a migration.', done_when: 'Tests cover reading and writing a setting.' },
  { title: 'Show settings on the page', description: 'Render the values in src/pages.js. Ping @everyone.', done_when: 'The page lists every setting.' },
];

test('a big issue is planned by a volunteer and split when the maintainer approves', async () => {
  const { coordinator, github } = setup();
  coordinator.issueToken('alice');
  await handleWebhook(coordinator, github, 'issues', planLabeled(60));
  assert.equal(github.comments.length, 1);

  const plan = coordinator.claim('alice');
  assert.equal(plan.kind, 'plan');
  await assert.rejects(coordinator.submit('alice', plan.id, `https://github.com/${REPO}/pull/1`), /not a build task/);
  await coordinator.submitPlan('alice', plan.id, SUBTASKS);
  assert.equal(coordinator.task(plan.id).status, 'planned');
  assert.match(github.comments.at(-1).body, /Proposed plan: 2 tasks/);
  assert.doesNotMatch(github.comments.at(-1).body, /@everyone/, 'volunteer text cannot ping people');
  assert.equal(github.issues.length, 0, 'nothing is created before approval');

  const approve = labeled(60, 'Big feature');
  approve.issue.labels.push({ name: 'barnraise-plan' });
  await handleWebhook(coordinator, github, 'issues', approve);
  assert.deepEqual(github.issues.map((i) => i.title), SUBTASKS.map((x) => x.title));
  assert.deepEqual(github.issues[0].labels, ['barnraise']);
  assert.match(github.issues[0].body, /Part of #60/);
  const open = coordinator.state().tasks;
  assert.deepEqual(open.map((t) => [t.kind, t.issue_number]).sort(), [['build', 101], ['build', 102]]);
  assert.match(github.comments.at(-1).body, /#101, #102/);
  assert.equal(coordinator.state().leaderboard[0].plans, 1);

  // GitHub also reports the label on each new issue, and later edits to the tracker issue.
  await handleWebhook(coordinator, github, 'issues', labeled(101, SUBTASKS[0].title));
  await handleWebhook(coordinator, github, 'issues', { ...approve, action: 'edited', label: undefined });
  assert.equal(coordinator.state().tasks.length, 2, 'no duplicates and no task for the tracker issue');
});

test('a plan can be discarded, and labelling for work before a plan exists makes one normal task', async () => {
  const { coordinator, github } = setup();
  await handleWebhook(coordinator, github, 'issues', planLabeled(70));
  const plan = coordinator.claim('alice');
  await coordinator.submitPlan('alice', plan.id, SUBTASKS);
  await handleWebhook(coordinator, github, 'issues', { ...planLabeled(70), action: 'unlabeled' });
  assert.equal(coordinator.task(plan.id).status, 'closed');
  assert.equal(coordinator.state().tasks.length, 0);

  await handleWebhook(coordinator, github, 'issues', planLabeled(71));
  const both = labeled(71, 'Big feature');
  both.issue.labels.push({ name: 'barnraise-plan' });
  await handleWebhook(coordinator, github, 'issues', both);
  assert.deepEqual(coordinator.state().tasks.map((t) => [t.kind, t.issue_number]), [['build', 71]]);
  assert.equal(github.issues.length, 0);
});
