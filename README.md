# Barnraise

Many people's coding agents, one open-source project.

Maintainers label the issues they want help with. Volunteers connect the coding agent they already use, it claims one task, does the work on the volunteer's machine, and the volunteer opens the pull request from their own GitHub account. A second volunteer's agent reviews it, and the maintainers merge.

Barnraise itself is only the task board. It never runs a model and never sees anyone's AI login, API key or code.

## Try it locally

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:8787. In dev mode you can sign in with any username on the Volunteer page, and unsigned webhooks are accepted so you can simulate a labelled issue:

```bash
curl -X POST http://localhost:8787/webhook -H "x-github-event: issues" -H "content-type: application/json" -d '{"action":"labeled","label":{"name":"barnraise"},"repository":{"full_name":"you/your-repo"},"issue":{"number":1,"title":"Fix the typo in the README","body":"teh -> the","state":"open","labels":[{"name":"barnraise"}]}}'
```

Run the tests with `npm test`.

## Run it for real

1. Put the server somewhere with a public HTTPS address and start it with `PUBLIC_URL=https://your.domain npm start`.
2. Open the setup link printed in the console. One click creates the GitHub App with the right permissions and stores its keys in `data/app.json`.
3. Install the app on a repository and label an issue `barnraise`.

Settings: `PORT` (default 8787), `PUBLIC_URL`, `BARNRAISE_DATA` (default `./data`).

On Railway: deploy this repository (it builds from the `Dockerfile`), attach a volume, and generate a domain. The server picks up the address and the volume path from Railway's own variables, so there is nothing to configure. Attach the volume before running setup, because the GitHub App keys are stored on it.

## How the pieces fit

| File | Job |
| --- | --- |
| `src/coordinator.js` | Tasks, claims, leases, the per-repo cap, credit |
| `src/webhooks.js` | Turns GitHub events (labels, merged pull requests) into task changes |
| `src/mcp.js` | The tools a volunteer's agent calls: `claim_task`, `submit_task`, `submit_review`, `submit_plan`, ... |
| `src/github.js` | GitHub App authentication, comments, reading `.github/barnraise.yml` |
| `src/server.js` | HTTP routes, sign-in, one-click app setup |
| `src/pages.js` | The web pages |

## Why it is built this way

Provider terms shaped the design. Anthropic's Claude Code terms say developers may not "route requests through Free, Pro, or Max plan credentials on behalf of their users" or "collect, store, or intermediate" credentials, while an end user may sign in to the unmodified Claude Code with their own subscription. OpenAI's consumer terms similarly forbid sharing credentials or making an account available to anyone else. So:

- There is no Barnraise worker program. The volunteer's own, unmodified agent connects to Barnraise as an ordinary MCP server.
- The volunteer starts each task, sees the change before it is pushed, and is the author of the pull request.
- Nobody is paid, and the terms page tells people who want unattended or bulk workers to use an API key.

This is a reading of the published terms, not legal advice and not a guarantee. Ask the providers before promoting Barnraise to subscription users at scale.

## Voting on features

Maintainers put the `barnraise-proposal` label on a feature idea. Volunteers vote by pledging their agent to it ("back Barnraise proposal #3"), one proposal at a time. When enough have pledged (3 by default, `proposal_threshold` in `.github/barnraise.yml`), the maintainers get a comment on the issue. Adding the `barnraise` label approves it and gives the backers first claim on the work for 48 hours; removing the proposal label declines it.

## Splitting big issues

Maintainers put the `barnraise-plan` label on an issue that is too big for one pull request. A volunteer's agent claims it as a planning task, reads the code, and submits 2 to 10 small tasks, which Barnraise posts on the issue. Adding the `barnraise` label approves the plan and creates one labelled issue per task; removing `barnraise-plan` discards it. The server still runs no model: planning is donated work like everything else.

## Not built yet

- Counting a volunteer's backing for less if they pledge and then never take the work

- Reputation tiers (new volunteers start on issues also labelled `good first issue`)
- Checking CI status before a review task is handed out
