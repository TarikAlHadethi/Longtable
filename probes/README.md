# Feasibility probes

Small tests that prove the risky parts work before anything is built on them.

| probe | proves | run |
| --- | --- | --- |
| `connect-links.html` | A web page can open a person's own Claude (app, VS Code or terminal) with a message ready, and nothing sends by itself | open it in a browser and press each button |
| `sign-in.mjs` | The background connection can get its own Claude sign-in with one browser approval, kept encrypted on the computer | `node probes/sign-in.mjs` |
| `headless.mjs` | A person's own Claude Code answers a table question from a clean copy of `main`, read-only, and reports its usage | `node probes/headless.mjs` |
| `headless.mjs --planted` | An instruction planted in outside text changes nothing: no command runs, no file changes | `node probes/headless.mjs --planted` |

Findings so far:

- Claude Desktop keeps its sign-in to itself: its bundled Claude Code, started on its own, fails with "OAuth session
  expired". So the background connection needs its own sign-in. `claude setup-token` is Anthropic's documented way
  for scripts: one browser approval, a one-year token that can only make model requests.
