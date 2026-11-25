---
description: Open the Engineering OS live view (agent graph, timeline, evidence, what is waiting for you)
---

Pick one way to show the live view, then tell the user in one or two lines where it is, that it refreshes by itself every two seconds while you work, and that it is read-only (approvals and decisions happen only in this session).

1. **This session runs on a remote machine** (the `SSH_CONNECTION` environment variable is set, or you know the session runs on a server, a container or a cloud machine): start `engos view --serve` as a background command (it keeps running). It prints the address plus an `ssh -N -L ...` command. Give the user both, exactly as printed: they run the ssh command on their own computer, then open the address in their own browser. If the server's address or user name shows as a placeholder, tell them to use the ones they log in with.

2. **The Claude desktop app with a browser pane you can drive**: its pane shows local files only as a static snapshot, so start `engos view --serve` as a background command and open the exact address it prints (`http://127.0.0.1:4317/<random>/`) in the pane.

3. **Otherwise**: run `engos view --open`. It writes `.engos/view/index.html`, tries to open it in the user's default browser, and prints its `file:///` address.

If you have no tool to open an address, don't look for one: print the address and ask the user to open it themselves.

The random part of a served address changes each run so other web pages can't read the project's state; don't log it anywhere else. The server listens only on 127.0.0.1, is read-only, and stops by itself after 8 hours.

Don't change anything else.
