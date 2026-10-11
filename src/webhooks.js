import { FIRST_LABEL, LABEL, PLAN_LABEL, PROPOSAL_LABEL } from './coordinator.js';

const hasLabel = (issue, name = LABEL) => (issue.labels ?? []).some((l) => l.name === name);

export async function handleWebhook(coordinator, github, event, payload, publicUrl = '') {
  const installationId = payload.installation?.id;
  const repo = payload.repository?.full_name;

  if (event === 'installation') {
    const repos = (payload.repositories ?? []).map((r) => r.full_name);
    for (const name of repos) {
      if (payload.action === 'deleted') coordinator.removeProject(name);
      else if (payload.action === 'created') coordinator.upsertProject(name, installationId);
    }
    return;
  }

  if (event === 'installation_repositories') {
    for (const r of payload.repositories_added ?? []) coordinator.upsertProject(r.full_name, installationId);
    for (const r of payload.repositories_removed ?? []) coordinator.removeProject(r.full_name);
    return;
  }

  if (event === 'issues' && repo) {
    const issue = payload.issue;
    if (issue.pull_request) return;
    const opening =
      (payload.action === 'labeled' && payload.label?.name === LABEL) ||
      (['edited', 'reopened'].includes(payload.action) && hasLabel(issue)) ||
      // Adding or removing "good first issue" on a task changes who can claim it.
      (['labeled', 'unlabeled'].includes(payload.action) && payload.label?.name === FIRST_LABEL && hasLabel(issue));
    const closing = (payload.action === 'unlabeled' && payload.label?.name === LABEL) || payload.action === 'closed';
    const proposing =
      (payload.action === 'labeled' && payload.label?.name === PROPOSAL_LABEL) ||
      (['edited', 'reopened'].includes(payload.action) && hasLabel(issue, PROPOSAL_LABEL));

    if (proposing && issue.state === 'open' && !hasLabel(issue)) {
      coordinator.upsertProject(repo, installationId, await github.getConfig(repo, installationId));
      coordinator.openProposal({ repo, number: issue.number, title: issue.title });
      return;
    }
    if ((payload.action === 'unlabeled' && payload.label?.name === PROPOSAL_LABEL) || payload.action === 'closed') {
      coordinator.closeProposal(repo, issue.number);
    }

    const planning =
      (payload.action === 'labeled' && payload.label?.name === PLAN_LABEL) ||
      (['edited', 'reopened'].includes(payload.action) && hasLabel(issue, PLAN_LABEL));
    const plan = coordinator.planTask(repo, issue.number);

    if (planning && issue.state === 'open' && !hasLabel(issue)) {
      coordinator.upsertProject(repo, installationId, await github.getConfig(repo, installationId));
      const { created } = coordinator.openPlanTask({ repo, number: issue.number, title: issue.title, body: issue.body ?? '' });
      if (created) {
        await github.comment(
          repo,
          installationId,
          issue.number,
          `A [Barnraise](${publicUrl || 'https://github.com'}) volunteer's agent will propose how to split this into small tasks. ` +
            `The plan will be posted here for you to approve before anything is built. Remove the \`${PLAN_LABEL}\` label to cancel.`
        );
      }
      return;
    }
    if ((payload.action === 'unlabeled' && payload.label?.name === PLAN_LABEL) || payload.action === 'closed') {
      coordinator.closePlanTask(repo, issue.number);
    }

    // This issue was already split into tasks: it is a tracker now, not work.
    if (plan?.status === 'done') return;
    if (opening && issue.state === 'open' && plan?.status === 'planned') {
      coordinator.upsertProject(repo, installationId);
      await coordinator.approvePlan(plan);
      return;
    }

    if (opening && issue.state === 'open') {
      coordinator.closePlanTask(repo, issue.number);
      coordinator.upsertProject(repo, installationId, await github.getConfig(repo, installationId));
      const { task, created } = coordinator.openIssueTask({
        repo,
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        goodFirst: hasLabel(issue, FIRST_LABEL),
      });
      coordinator.approveProposal(repo, issue.number, task.id);
      if (created) {
        await github.comment(
          repo,
          installationId,
          issue.number,
          `This issue is now open to [Barnraise](${publicUrl || 'https://github.com'}) volunteers. ` +
            `One volunteer at a time will pick it up with their own coding agent and open a pull request from their own account. ` +
            `Remove the \`${LABEL}\` label to take it back.`
        );
      }
    } else if (closing) {
      coordinator.closeIssueTask(repo, issue.number);
    }
    return;
  }

  if (event === 'pull_request' && repo) {
    const pull = payload.pull_request;
    if (payload.action === 'closed') {
      coordinator.onPullClosed(repo, pull.number, Boolean(pull.merged));
    } else if (['opened', 'reopened'].includes(payload.action)) {
      coordinator.onPullOpened(repo, {
        number: pull.number,
        url: pull.html_url,
        author: pull.user?.login,
        body: pull.body,
        branch: pull.head?.ref,
      });
    }
  }
}
