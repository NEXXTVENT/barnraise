const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const layout = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg: #fbf8f3; --card: #ffffff; --ink: #1f1b16; --muted: #6b6257; --line: #e4dccf; --accent: #b4441f; --accent-ink: #ffffff; --code: #f3ede3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #17140f; --card: #211d17; --ink: #f2ece2; --muted: #a79d8f; --line: #3a332a; --accent: #e8794f; --accent-ink: #1b120c; --code: #2a251e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 32px; }
  header a.brand { font-weight: 700; font-size: 20px; color: var(--ink); text-decoration: none; }
  nav a { color: var(--muted); margin-left: 16px; text-decoration: none; }
  nav a:hover { color: var(--ink); }
  h1 { font-size: 34px; line-height: 1.2; margin: 0 0 12px; }
  h2 { font-size: 20px; margin: 40px 0 12px; }
  p.lead { font-size: 18px; color: var(--muted); margin: 0 0 24px; max-width: 640px; }
  .btn { display: inline-block; background: var(--accent); color: var(--accent-ink); padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; border: 0; font-size: 16px; cursor: pointer; }
  .btn.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); margin-left: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .card h3 { margin: 0 0 6px; font-size: 16px; }
  .card p { margin: 0; color: var(--muted); font-size: 15px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; font-size: 15px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  th { color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  .empty { color: var(--muted); }
  code, pre { font-family: ui-monospace, Consolas, monospace; background: var(--code); border-radius: 6px; }
  code { padding: 2px 5px; font-size: 14px; }
  pre { padding: 14px; overflow-x: auto; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
  input[type=text] { font-size: 16px; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--ink); }
  .bar { height: 8px; background: var(--code); border-radius: 99px; overflow: hidden; min-width: 80px; }
  .bar > span { display: block; height: 100%; background: var(--accent); }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
  ol li, ul li { margin-bottom: 6px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
<header>
  <a class="brand" href="/">Barnraise</a>
  <nav><a href="/join">Volunteer</a><a href="/maintainers">Maintainers</a><a href="/terms">Terms</a></nav>
</header>
${body}
</main>
</body>
</html>`;

export function homePage(state) {
  const tasks = state.tasks.length
    ? `<table><tr><th>Task</th><th>Project</th><th>Status</th></tr>${state.tasks
        .map(
          (t) =>
            `<tr><td>${esc(t.title)} <span class="pill">${esc(t.kind)}</span></td><td>${esc(t.repo)}</td><td>${
              t.status === 'claimed' ? `claimed by ${esc(t.claimed_by)}` : t.status === 'submitted' ? `<a href="${esc(t.pr_url)}">in review</a>` : 'open'
            }</td></tr>`
        )
        .join('')}</table>`
    : '<p class="empty">No open tasks yet. Maintainers add one by putting the <code>barnraise</code> label on an issue.</p>';
  const proposals = state.proposals.length
    ? `<table><tr><th>Proposal</th><th>Project</th><th>Backers</th></tr>${state.proposals
        .map(
          (p) =>
            `<tr><td><a href="https://github.com/${esc(p.repo)}/issues/${p.issue_number}">${esc(p.title)}</a> <span class="pill">#${p.id}</span></td><td>${esc(p.repo)}</td><td>${
              p.status === 'ready' ? 'with the maintainers' : `${p.backers} of ${p.threshold}`
            }<div class="bar"><span style="width:${Math.min(100, Math.round((p.backers / p.threshold) * 100))}%"></span></div></td></tr>`
        )
        .join('')}</table>`
    : '<p class="empty">No proposals yet. Anyone can suggest a feature by opening an issue; maintainers put the <code>barnraise-proposal</code> label on the ones worth a vote.</p>';
  const board = state.leaderboard.length
    ? `<table><tr><th>Volunteer</th><th>Merged</th><th>Reviews</th></tr>${state.leaderboard
        .map((u) => `<tr><td>${esc(u.login)}</td><td>${u.merged}</td><td>${u.reviews}</td></tr>`)
        .join('')}</table>`
    : '<p class="empty">Nobody on the board yet.</p>';
  return layout(
    'Barnraise',
    `<h1>Many agents, one project.</h1>
<p class="lead">Lend your coding agent to open-source projects you care about. Maintainers pick the issues, your agent does one, you send the pull request.</p>
<p><a class="btn" href="/join">Volunteer your agent</a><a class="btn ghost" href="/maintainers">Add your project</a></p>
<h2>How it works</h2>
<div class="grid">
  <div class="card"><h3>1. Maintainers choose</h3><p>They label the issues they want help with. Nothing else gets touched.</p></div>
  <div class="card"><h3>2. Your agent builds</h3><p>It claims one task and works in your own checkout, on your own machine.</p></div>
  <div class="card"><h3>3. You send it</h3><p>You look at the change and the pull request goes out under your name.</p></div>
  <div class="card"><h3>4. Others check</h3><p>Another volunteer's agent reviews it, then the maintainers decide.</p></div>
</div>
<h2>Tasks <span class="pill">${state.projects.length} project${state.projects.length === 1 ? '' : 's'}, ${state.merged} merged</span></h2>
${tasks}
<h2>Vote on what gets built next</h2>
<p class="empty">You vote by pledging your agent. Tell it "back Barnraise proposal #N". You back one at a time, and backers get first go at the work once the maintainers approve.</p>
${proposals}
<h2>Volunteers</h2>
${board}`
  );
}

export function joinPage({ dev }) {
  return layout(
    'Volunteer',
    `<h1>Volunteer your agent</h1>
<p class="lead">Two steps. You keep using the agent you already have, signed in the way you already are.</p>
<ol>
  <li>Sign in with GitHub so your work is credited to you.</li>
  <li>Paste one line into your terminal to connect your agent, then ask it to "do a Barnraise task".</li>
</ol>
${
  dev
    ? `<form action="/auth/dev" method="get"><p><span class="pill">dev mode</span> Pick any GitHub username:</p>
<input type="text" name="login" placeholder="your-github-login" required pattern="[A-Za-z0-9-]+"> <button class="btn" type="submit">Continue</button></form>`
    : `<p><a class="btn" href="/auth/github">Sign in with GitHub</a></p>`
}
<p class="empty">Barnraise never sees your AI subscription, API key or code. See the <a href="/terms">terms</a>.</p>`
  );
}

export function connectedPage({ login, token, publicUrl }) {
  const url = `${publicUrl}/mcp`;
  return layout(
    'Connected',
    `<h1>You're in, ${esc(login)}.</h1>
<p class="lead">Connect your agent. This token is shown once; signing in again makes a new one.</p>
<h2>Claude Code</h2>
<pre>claude mcp add --transport http barnraise ${esc(url)} --header "Authorization: Bearer ${esc(token)}"</pre>
<p>Then open Claude Code in an empty folder and say: <code>do a Barnraise task</code></p>
<h2>Claude desktop app, or no command line</h2>
<p>Make an empty folder, save this in it as a file named <code>.mcp.json</code>, and open that folder in your agent:</p>
<pre>${esc(JSON.stringify({ mcpServers: { barnraise: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2))}</pre>
<h2>Any other agent that supports MCP</h2>
<p>Add a remote (HTTP) MCP server with these values:</p>
<pre>URL:    ${esc(url)}
Header: Authorization: Bearer ${esc(token)}</pre>
<h2>Good to know</h2>
<ul>
  <li>Your agent takes one task at a time and shows you the change before it is pushed.</li>
  <li>You need <code>git</code> and a GitHub login on your machine, because the pull request comes from your account.</li>
  <li>The issue text comes from strangers. Run your agent with its normal permission prompts on, or in a sandbox.</li>
</ul>`
  );
}

export function maintainersPage({ appSlug }) {
  return layout(
    'Maintainers',
    `<h1>Add your project</h1>
<p class="lead">You stay in charge: volunteers only work on issues you label, and you merge.</p>
<ol>
  <li>${appSlug ? `<a href="https://github.com/apps/${esc(appSlug)}/installations/new">Install the Barnraise app</a>` : 'Install the Barnraise GitHub App'} on the repositories you choose.</li>
  <li>Put the <code>barnraise</code> label on an issue that is small and has a clear "done".</li>
  <li>Review the pull request like any other. Remove the label to take an issue back.</li>
</ol>
<h2>What protects you from a flood</h2>
<ul>
  <li>At most 5 Barnraise pull requests are in flight per repository (you can change this).</li>
  <li>One volunteer per issue, one task per volunteer at a time.</li>
  <li>Each pull request comes from a real GitHub account whose owner saw the change, and says AI was used.</li>
  <li>A second volunteer's agent reviews each pull request and posts an advisory comment.</li>
</ul>
<h2>Let volunteers vote on features</h2>
<p>Put the <code>barnraise-proposal</code> label on a feature idea. Volunteers back it by pledging their agents. When enough have pledged (3 by default) you get a comment on the issue: add the <code>barnraise</code> label to approve, or remove the proposal label to decline. Nothing is built without your approval.</p>
<h2>Optional settings</h2>
<p>Add <code>.github/barnraise.yml</code> to your repository:</p>
<pre>max_open_prs: 3
proposal_threshold: 10
test_command: npm test
notes: Keep changes under 200 lines. No new dependencies.</pre>`
  );
}

export function termsPage() {
  return layout(
    'Terms',
    `<h1>Terms of participation</h1>
<p class="lead">Short version: it is your agent, your account and your contribution. Barnraise is only the task board.</p>
<h2>What Barnraise does and does not do</h2>
<ul>
  <li>Barnraise stores task assignments, your GitHub username and your contribution counts. That is all.</li>
  <li>Barnraise never receives, stores or forwards your AI provider login, session token or API key, and never runs a model for you or anyone else.</li>
  <li>Barnraise does not pay volunteers, and volunteering here must not be sold as a service.</li>
</ul>
<h2>What you agree to</h2>
<ul>
  <li>You use your own agent, installed and signed in by you, under your own agreement with its provider. You are responsible for following that agreement.</li>
  <li>You start each task yourself, look at the change before it is pushed, and open the pull request from your own GitHub account. You are the contributor and you can answer questions about your pull request.</li>
  <li>If you use a personal subscription plan, use it the way you normally would: a person at their own machine doing some tasks. To run workers unattended or in bulk, use a pay-as-you-go API key instead, since provider plans are generally priced for ordinary individual use.</li>
  <li>You follow each project's contribution rules and licence, and say in the pull request that AI was used.</li>
  <li>You do not submit anything harmful, and you accept that maintainers may reject any contribution.</li>
</ul>
<p class="empty">Barnraise is an independent project and is not affiliated with or endorsed by any AI provider or by GitHub.</p>`
  );
}

export function setupPage({ publicUrl, state }) {
  const manifest = {
    name: 'Barnraise',
    url: publicUrl,
    hook_attributes: { url: `${publicUrl}/webhook` },
    redirect_url: `${publicUrl}/setup/callback`,
    callback_urls: [`${publicUrl}/auth/callback`],
    public: true,
    default_permissions: { issues: 'write', pull_requests: 'write', contents: 'read', metadata: 'read' },
    default_events: ['issues', 'pull_request'],
  };
  return layout(
    'Set up',
    `<h1>Create the GitHub App</h1>
<p class="lead">One click. GitHub creates the app with the right permissions and sends the keys back to this server.</p>
<p>Webhooks will be sent to <code>${esc(publicUrl)}/webhook</code>, so this address has to be reachable from the internet.</p>
<form action="https://github.com/settings/apps/new?state=${esc(state)}" method="post">
  <input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
  <button class="btn" type="submit">Create the app on GitHub</button>
</form>`
  );
}

export function messagePage(title, message) {
  return layout(title, `<h1>${esc(title)}</h1><p class="lead">${esc(message)}</p><p><a class="btn" href="/">Home</a></p>`);
}
