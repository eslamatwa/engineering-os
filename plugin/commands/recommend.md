---
description: Recommend official plugins (skills and MCP servers) that fit this project, with the commands to install them
---

Run `engos recommend` with the Bash tool. It reads what this project is made of (languages, dependencies, config files, where the repo is hosted) and lists matching plugins from Anthropic's official marketplace only, with their install counts.

Show the user the result grouped as it prints: **Skills and workflows**, **MCP servers**, **Code intelligence**. For each one give the name, one line on why it fits this project, and both install commands exactly as printed (`/plugin install …` inside a session, or `claude plugin install …` in a terminal).

Never install anything yourself, and don't run `claude` from Bash (it is blocked anyway). The user picks and runs the commands. Remind them to start a new session after installing, and that tools from a new MCP server ask before each call until they add read-only ones to `mcp_allowlist` in `.engos/config.yaml`.

If `engos recommend` can't read the catalog, say so and suggest `/plugin` to browse the official marketplace.
