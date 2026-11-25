---
description: Set up Engineering OS in the current project (.engos/ folder, checks, models, optional protection)
---

Set up Engineering OS in this project. Follow these steps in order and keep the conversation short.

1. Run `engos doctor` with the Bash tool only if a `.engos/` folder already exists here. If it exists, tell the user it's already set up, show the doctor result, and ask whether they want to fill in anything missing. Stop if they say no. Running `engos init` again never changes `.engos/config.yaml`: models, checks and known commands are changed by editing that file, which the user may do or ask you to do. If doctor reports that no hook has run, say plainly that edits and commands are NOT protected yet, before anything else.

2. Check prerequisites with the Bash tool: `node --version` and `git rev-parse --is-inside-work-tree`. Node 18 or newer is required. If Node is missing, tell the user how to install it and stop.

3. Ask the user these questions in one go (use the AskUserQuestion tool if available):
   - **Git:** only if this isn't a git repo: "Engineering OS needs git for edits. Run git init here?" (Yes / No, stay read-only)
   - **Models:** "Which Claude models does your plan include?" (multi-select: Haiku, Sonnet, Opus, Fable). Default: Haiku, Sonnet, Opus.
   - **Checks:** "Which commands prove the code works?" Look at the project first (package.json scripts, Makefile, pyproject, etc.) and offer the real commands you found for test, lint and build. Let the user edit or skip each one.
   - **Protection:** "Add deny rules to .claude/settings.json so Claude can't edit Engineering OS records directly?" (Yes recommended / No)
   - **Status line:** "Show what Engineering OS is doing in a status line under the prompt?" (Yes recommended / No). It goes in .claude/settings.local.json, which stays on this machine.

4. Run `engos init` with their answers, for example:
   `engos init --models haiku,sonnet,opus --check "test=npm test" --check "lint=npm run lint" --deny-rules --status-line --git-init`
   Only pass `--deny-rules`, `--status-line` and `--git-init` if the user said yes.

5. Show the user what was created, then suggest two things: fill in `.engos/BRIEF.md`, and add their sensitive folders under `protected_paths` in `.engos/config.yaml`. Tell them a new session picks up everything automatically, and that `/engos:view` opens the live view.

6. Then run `engos recommend` and show the user, in a few lines, the official skills and MCP servers that fit this project with their install commands (see /engos:recommend). Don't install anything.

Never edit files under `.engos/` yourself during setup; `engos init` writes them.
