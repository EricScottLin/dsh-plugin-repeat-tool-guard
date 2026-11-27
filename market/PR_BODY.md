Adds **dsh-plugin-repeat-tool-guard** under `security`.

- Repo: https://github.com/EricScottLin/dsh-plugin-repeat-tool-guard
- npm: https://www.npmjs.com/package/dsh-plugin-repeat-tool-guard

It hard-stops unattended `web_fetch` loops:

- normalises the fetch target (drops query/fragment, lowercases the host, strips trailing `.md5` / `.sig` / `.txt` / etc.);
- records 4xx/5xx failures and refuses every suffix/query variant after two failures;
- caps fetches per target;
- cancels the whole turn after 60 tool calls, 30 `web_fetch` calls, or 15 minutes; caps `web_fetch` at 120 per hour across turns;
- user messages clear duplicate memory but do **not** reset those budgets.

Why it exists: a real DSH `0.2.2-rc.5` session on `deepseek-v4-1-flash-1017` fetched one `chart_stats` URL 229 times (488 `web_fetch` calls over four turns). The in-tree reminder is advisory; result-fingerprint guards see the changing spill path as progress; exact-argument guards treat a new suffix or query as a new call and reset on user messages.

Verification: 10 unit tests; a live four-call reproduction blocks calls 3–4 with no network request. The package installs from npm and from GitHub, declares `dsh.bundle`, and the repo has the `dsh-plugin` topic.
