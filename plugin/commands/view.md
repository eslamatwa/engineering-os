---
description: Open the Engineering OS live view (agent graph, timeline, evidence, what is waiting for you)
---

Run `engos view --open` with the Bash tool. It writes the live view page to `.engos/view/index.html`, opens it in the user's default browser, and prints its `file:///` address.

Then tell the user in one or two lines:
- the address, so they can open it again or in another browser,
- that it refreshes by itself every two seconds while you work,
- that it is read-only: approvals and decisions still happen only in this session.

If you are running inside the Claude desktop app with a browser pane, its pane shows local files only as a static snapshot. There, instead, start `engos view --serve` as a background command (it keeps running), then open the exact address it prints (`http://127.0.0.1:4317/<random>/`) in the pane. The random part changes each run so other web pages can't read the project's state; don't share or log it. The server is local to this machine, read-only, and stops by itself after 8 hours.

Don't change anything else.
