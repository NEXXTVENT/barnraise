import { createHash, randomBytes } from 'node:crypto';

export const LABEL = 'barnraise';
export const PROPOSAL_LABEL = 'barnraise-proposal';
const LEASE_MS = 2 * 60 * 60 * 1000;
// How long the volunteers who backed a proposal get first claim on its task.
const BACKER_PRIORITY_MS = 48 * 60 * 60 * 1000;

export class TaskError extends Error {}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const sameLogin = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function parsePrUrl(url) {
  const m = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/.exec(String(url).trim());
  if (!m) throw new TaskError('That is not a GitHub pull request URL (expected https://github.com/owner/repo/pull/123).');
  return { repo: m[1], number: Number(m[2]) };
}

// The coordinator only tracks who is doing what. It never runs a model and never
// sees anyone's model credentials: all the work happens in the volunteer's own agent.
export class Coordinator {
  constructor({ db, github, now = () => Date.now() }) {
    this.db = db;
    this.github = github;
    this.now = now;
  }

  // ---- users ----

  issueToken(login) {
    const token = 'brz_' + randomBytes(24).toString('hex');
    this.db
      .prepare(
        `INSERT INTO users (login, token_hash, created_at) VALUES (?, ?, ?)
         ON CONFLICT(login) DO UPDATE SET token_hash = excluded.token_hash`
      )
      .run(login, hashToken(token), this.now());
    return token;
  }

  userForToken(token) {
    if (!token) return null;
    return this.db.prepare('SELECT * FROM users WHERE token_hash = ?').get(hashToken(token)) ?? null;
  }

  // ---- projects ----

  upsertProject(repo, installationId, config = {}) {
    this.db
      .prepare(
        `INSERT INTO projects (repo, installation_id) VALUES (?, ?)
         ON CONFLICT(repo) DO UPDATE SET installation_id = excluded.installation_id`
      )
      .run(repo, installationId ?? null);
    for (const key of ['max_open_prs', 'proposal_threshold']) {
      if (Number.isInteger(config[key]) && config[key] > 0) {
        this.db.prepare(`UPDATE projects SET ${key} = ? WHERE repo = ?`).run(config[key], repo);
      }
    }
    for (const key of ['test_command', 'notes']) {
      if (typeof config[key] === 'string') {
        this.db.prepare(`UPDATE projects SET ${key} = ? WHERE repo = ?`).run(config[key], repo);
      }
    }
  }

  removeProject(repo) {
    this.db.prepare(`UPDATE tasks SET status = 'closed' WHERE repo = ? AND status IN ('open', 'claimed')`).run(repo);
    for (const p of this.proposals({ repo })) this.closeProposal(repo, p.issue_number);
    this.db.prepare('DELETE FROM projects WHERE repo = ?').run(repo);
  }

  project(repo) {
    return this.db.prepare('SELECT * FROM projects WHERE repo = ?').get(repo) ?? null;
  }

  // ---- tasks from issues ----

  openIssueTask({ repo, number, title, body }) {
    const existing = this.db
      .prepare(`SELECT * FROM tasks WHERE repo = ? AND issue_number = ? AND kind = 'build' AND status != 'closed'`)
      .get(repo, number);
    if (existing) {
      this.db.prepare('UPDATE tasks SET title = ?, body = ? WHERE id = ?').run(title, body ?? '', existing.id);
      return { task: this.task(existing.id), created: false };
    }
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO tasks (repo, kind, issue_number, title, body, created_at) VALUES (?, 'build', ?, ?, ?, ?)`)
      .run(repo, number, title, body ?? '', this.now());
    return { task: this.task(Number(lastInsertRowid)), created: true };
  }

  closeIssueTask(repo, number) {
    this.db
      .prepare(
        `UPDATE tasks SET status = 'closed', claimed_by = NULL, lease_expires = NULL
         WHERE repo = ? AND issue_number = ? AND kind = 'build' AND status IN ('open', 'claimed')`
      )
      .run(repo, number);
  }

  task(id) {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
  }

  expireLeases() {
    this.db
      .prepare(
        `UPDATE tasks SET status = 'open', claimed_by = NULL, lease_expires = NULL
         WHERE status = 'claimed' AND lease_expires < ?`
      )
      .run(this.now());
  }

  // Build work a repo already has in flight. Capping it is what keeps maintainers
  // from being flooded with pull requests.
  inFlight(repo) {
    return this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE repo = ? AND kind = 'build' AND status IN ('claimed', 'submitted')`)
      .get(repo).n;
  }

  claimable(login, { repo, kind } = {}) {
    this.expireLeases();
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE status = 'open' ORDER BY kind = 'review' DESC, id`).all();
    return rows.filter((t) => {
      if (repo && !sameLogin(t.repo, repo)) return false;
      if (kind && t.kind !== kind) return false;
      if (t.kind === 'review') return !sameLogin(t.author, login);
      const backersOnly = t.proposal_id && this.now() < t.created_at + BACKER_PRIORITY_MS;
      if (backersOnly && !this.hasBacked(login, t.proposal_id)) return false;
      const project = this.project(t.repo);
      return project && this.inFlight(t.repo) < project.max_open_prs;
    });
  }

  claim(login, { taskId, repo, kind } = {}) {
    this.expireLeases();
    const held = this.db.prepare(`SELECT * FROM tasks WHERE status = 'claimed' AND claimed_by = ?`).get(login);
    if (held) {
      if (taskId && taskId !== held.id) {
        throw new TaskError(`You already hold task #${held.id}. Finish it or call release_task first.`);
      }
      return held;
    }
    const candidates = this.claimable(login, { repo, kind });
    const chosen = taskId ? candidates.find((t) => t.id === taskId) : candidates[0];
    if (!chosen) {
      throw new TaskError(
        taskId
          ? `Task #${taskId} is not available (already taken, finished, or its project is at its pull request limit).`
          : 'No tasks are available right now. Try again later.'
      );
    }
    this.db
      .prepare(`UPDATE tasks SET status = 'claimed', claimed_by = ?, lease_expires = ? WHERE id = ?`)
      .run(login, this.now() + LEASE_MS, chosen.id);
    return this.task(chosen.id);
  }

  heldBy(login, taskId) {
    const task = this.task(taskId);
    if (!task || task.status !== 'claimed' || !sameLogin(task.claimed_by, login)) {
      throw new TaskError(`You do not hold task #${taskId}. It may have expired; call claim_task again.`);
    }
    return task;
  }

  release(login, taskId) {
    this.heldBy(login, taskId);
    this.db
      .prepare(`UPDATE tasks SET status = 'open', claimed_by = NULL, lease_expires = NULL WHERE id = ?`)
      .run(taskId);
  }

  async submit(login, taskId, prUrl) {
    const current = this.task(taskId);
    // Usually the pull request has already been recorded from GitHub's own notification.
    if (current?.status === 'submitted' && sameLogin(current.author, login)) return current;
    const task = this.heldBy(login, taskId);
    if (task.kind !== 'build') throw new TaskError('This is a review task. Use submit_review.');
    if (!prUrl) {
      throw new TaskError('No pull request has been seen for this task yet. Once it is open, call submit_task again with its URL.');
    }
    const pr = parsePrUrl(prUrl);
    if (!sameLogin(pr.repo, task.repo)) {
      throw new TaskError(`The pull request must be opened against ${task.repo}, not ${pr.repo}.`);
    }
    const project = this.project(task.repo);
    const pull = await this.github.getPull(task.repo, project?.installation_id, pr.number);
    if (!pull) throw new TaskError(`Could not find pull request #${pr.number} on ${task.repo}.`);
    if (pull.state !== 'open') throw new TaskError(`Pull request #${pr.number} is not open.`);
    // The PR has to come from the volunteer's own GitHub account: they are the contributor.
    if (!sameLogin(pull.user?.login, login)) {
      throw new TaskError(`Pull request #${pr.number} was opened by ${pull.user?.login}, but you are signed in as ${login}.`);
    }
    return this.recordSubmission(task, login, pr.number, pull.html_url ?? prUrl);
  }

  recordSubmission(task, login, number, url) {
    this.db
      .prepare(
        `UPDATE tasks SET status = 'submitted', pr_number = ?, pr_url = ?, author = ?, claimed_by = NULL, lease_expires = NULL
         WHERE id = ?`
      )
      .run(number, url, login, task.id);
    this.db
      .prepare(
        `INSERT INTO tasks (repo, kind, issue_number, title, body, pr_number, pr_url, author, parent_id, created_at)
         VALUES (?, 'review', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(task.repo, task.issue_number, `Review pull request #${number}: ${task.title}`, task.body, number, url, login, task.id, this.now());
    return this.task(task.id);
  }

  // A pull request was opened on a project. If its author holds a task there and the
  // pull request names it, record it so the volunteer does not have to report it.
  onPullOpened(repo, { number, url, author, body, branch }) {
    this.expireLeases();
    const held = this.db
      .prepare(`SELECT * FROM tasks WHERE repo = ? AND kind = 'build' AND status = 'claimed'`)
      .all(repo)
      .filter((t) => sameLogin(t.claimed_by, author));
    const task = held.find(
      (t) => new RegExp(`Barnraise task #${t.id}\\b`).test(body ?? '') || String(branch).startsWith(`barnraise/${t.issue_number}-`)
    );
    return task ? this.recordSubmission(task, task.claimed_by, number, url) : null;
  }

  async submitReview(login, taskId, verdict, notes) {
    const task = this.heldBy(login, taskId);
    if (task.kind !== 'review') throw new TaskError('This is a build task. Use submit_task.');
    this.db
      .prepare(`UPDATE tasks SET status = 'done', claimed_by = NULL, lease_expires = NULL WHERE id = ?`)
      .run(taskId);
    this.db.prepare('UPDATE users SET reviews = reviews + 1 WHERE login = ?').run(login);
    const heading = { approve: 'Looks good', request_changes: 'Changes suggested', flag: 'Flagged for a careful look' }[verdict];
    const project = this.project(task.repo);
    await this.github.comment(
      task.repo,
      project?.installation_id,
      task.pr_number,
      `**Barnraise volunteer review: ${heading}**\n\n${notes}\n\n` +
        `_Advisory review from @${login}'s agent. The maintainers decide what gets merged._`
    );
    return this.task(taskId);
  }

  onPullClosed(repo, number, merged) {
    const task = this.db
      .prepare(`SELECT * FROM tasks WHERE repo = ? AND kind = 'build' AND pr_number = ? AND status = 'submitted'`)
      .get(repo, number);
    if (!task) return null;
    if (merged) {
      this.db.prepare(`UPDATE tasks SET status = 'merged' WHERE id = ?`).run(task.id);
      this.db.prepare('UPDATE users SET merged = merged + 1 WHERE login = ?').run(task.author);
    } else {
      // Closed without merging: the issue goes back in the queue for someone else.
      this.db
        .prepare(`UPDATE tasks SET status = 'open', pr_number = NULL, pr_url = NULL, author = NULL WHERE id = ?`)
        .run(task.id);
    }
    this.db
      .prepare(
        `UPDATE tasks SET status = 'closed', claimed_by = NULL, lease_expires = NULL
         WHERE parent_id = ? AND status IN ('open', 'claimed')`
      )
      .run(task.id);
    return this.task(task.id);
  }

  // ---- proposals: volunteers vote for a feature by pledging their agent to it ----

  openProposal({ repo, number, title }) {
    const existing = this.db
      .prepare(`SELECT * FROM proposals WHERE repo = ? AND issue_number = ? AND status != 'closed'`)
      .get(repo, number);
    if (existing) {
      this.db.prepare('UPDATE proposals SET title = ? WHERE id = ?').run(title, existing.id);
      return existing.id;
    }
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO proposals (repo, issue_number, title, created_at) VALUES (?, ?, ?, ?)')
      .run(repo, number, title, this.now());
    return Number(lastInsertRowid);
  }

  pendingProposal(repo, number) {
    return (
      this.db
        .prepare(`SELECT * FROM proposals WHERE repo = ? AND issue_number = ? AND status IN ('open', 'ready')`)
        .get(repo, number) ?? null
    );
  }

  // The maintainer declined it or closed the issue. Approved proposals are left alone.
  closeProposal(repo, number) {
    const proposal = this.pendingProposal(repo, number);
    if (!proposal) return;
    this.db.prepare(`UPDATE proposals SET status = 'closed' WHERE id = ?`).run(proposal.id);
    this.db.prepare('DELETE FROM pledges WHERE proposal_id = ?').run(proposal.id);
  }

  // The maintainer put the work label on a proposal: it becomes a task and its backers go first.
  approveProposal(repo, number, taskId) {
    const proposal = this.pendingProposal(repo, number);
    if (!proposal) return;
    this.db.prepare(`UPDATE proposals SET status = 'approved' WHERE id = ?`).run(proposal.id);
    this.db.prepare('UPDATE tasks SET proposal_id = ? WHERE id = ?').run(proposal.id, taskId);
  }

  hasBacked(login, proposalId) {
    return Boolean(this.db.prepare('SELECT 1 FROM pledges WHERE login = ? AND proposal_id = ?').get(login, proposalId));
  }

  proposals({ repo } = {}) {
    return this.db
      .prepare(
        `SELECT p.id, p.repo, p.issue_number, p.title, p.status,
                (SELECT COUNT(*) FROM pledges WHERE proposal_id = p.id) AS backers,
                COALESCE(pr.proposal_threshold, 3) AS threshold
         FROM proposals p LEFT JOIN projects pr ON pr.repo = p.repo
         WHERE p.status IN ('open', 'ready') ORDER BY backers DESC, p.id`
      )
      .all()
      .filter((p) => !repo || sameLogin(p.repo, repo));
  }

  async back(login, proposalId) {
    if (!this.proposals().some((p) => p.id === proposalId)) {
      throw new TaskError(`Proposal #${proposalId} is not open for backing.`);
    }
    // Backing a new proposal moves your pledge: one agent, one vote.
    this.db
      .prepare(
        `INSERT INTO pledges (login, proposal_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(login) DO UPDATE SET proposal_id = excluded.proposal_id, created_at = excluded.created_at`
      )
      .run(login, proposalId, this.now());
    const proposal = this.proposals().find((p) => p.id === proposalId);
    if (proposal.status === 'open' && proposal.backers >= proposal.threshold) {
      this.db.prepare(`UPDATE proposals SET status = 'ready' WHERE id = ?`).run(proposalId);
      proposal.status = 'ready';
      await this.github.comment(
        proposal.repo,
        this.project(proposal.repo)?.installation_id,
        proposal.issue_number,
        `**${proposal.backers} Barnraise volunteers have pledged their agents to build this.**\n\n` +
          `Maintainers: add the \`${LABEL}\` label to approve it, or remove \`${PROPOSAL_LABEL}\` to decline. ` +
          `Nothing is built unless you approve.`
      );
    }
    return proposal;
  }

  withdraw(login) {
    this.db.prepare('DELETE FROM pledges WHERE login = ?').run(login);
  }

  // ---- public state for the dashboard ----

  state() {
    this.expireLeases();
    return {
      projects: this.db.prepare('SELECT repo, max_open_prs FROM projects ORDER BY repo').all(),
      proposals: this.proposals(),
      tasks: this.db
        .prepare(
          `SELECT id, repo, kind, issue_number, title, status, claimed_by, author, pr_url
           FROM tasks WHERE status IN ('open', 'claimed', 'submitted') ORDER BY id DESC LIMIT 200`
        )
        .all(),
      leaderboard: this.db
        .prepare(
          `SELECT login, merged, reviews FROM users WHERE merged + reviews > 0
           ORDER BY merged DESC, reviews DESC, login LIMIT 50`
        )
        .all(),
      merged: this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'merged'`).get().n,
    };
  }
}
