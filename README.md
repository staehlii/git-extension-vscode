# Git (JetBrains style) for VS Code

Internal extension that brings the JetBrains Git workflow to VS Code. Built in phases (see plan).

## Status
- [x] Phase 1: scaffold, git CLI wrapper, repo tracking, `jbgit:` revision documents, Git Console (output channel)
- [x] Phase 2: Branches popup + status-bar branch widget, Update Project, Push dialog, Smart Checkout, Continue/Abort
- [x] Phase 3: Commit window + changelists
- [x] Phase 4: Git Log graph
- [ ] Phase 5: Conflicts view + interactive rebase

## Run
```
npm install
npm run build      # or: npm run watch
npm test           # typecheck + unit tests + git integration tests (temp repos)
npm run test:e2e   # headless VS Code (xvfb) end-to-end tests, uses /usr/share/code/code (override: VSCODE_PATH)
```
Press F5 in VS Code ("Run Extension") to open an Extension Development Host.

## Commit window
Activity bar icon **Commit (JB)** (or `Git (JB): Commit…`):
- **Changes** tree: changelists, *Unversioned Files* and *Merge Conflicts*. Tick the files to commit;
  the active changelist's files start ticked, and new changes land in the active changelist.
- Click a file for its diff against HEAD. Right-click for Rollback, Move to Another Changelist,
  Set Active / Rename / Delete Changelist, Delete or Add to .gitignore (unversioned files).
- **Commit Message** panel: message (Ctrl+Enter commits), *Amend* (prefills the last message and warns
  if it was already pushed), *History…*, **Commit** and **Commit and Push…**.
- Only the ticked files are committed (`git commit --only`); anything else you staged stays staged.
  During a merge, git requires committing all changes together, and the panel says so.
- Changelists are stored per repository in VS Code's workspace state.

## Git Log
Bottom panel tab **Git (JB) → Log** (or `Git (JB): Show Git Log`), like JetBrains' Git tool window:
- Commit table with branch graph, branch/tag badges (filled = checked-out branch), author, date and hash.
  Click, Ctrl+click, Shift+click and arrow keys select commits; more commits load while scrolling.
- Toolbar filters: text or hash, Branch, User, Date and Paths. With text/user/date/path filters the
  graph is hidden, because those filters leave gaps in the history (JetBrains does the same).
- Details pane: changed files (click one for its diff against the first parent), full message, author,
  committer and the branches containing the commit. Drag the splitter to resize.
- Right-click a commit: Copy Revision Number, Checkout Revision, New Branch…, New Tag…, Cherry-Pick,
  Revert Commit, Reset Current Branch to Here…, Undo Commit… and Edit Commit Message… (HEAD only),
  Compare with Local and Create Patch…. Cherry-pick, revert and patch work on multiple selected commits.
- **Show History for File**: right-click a file in the Explorer, an editor tab or the editor.
- The log reloads automatically when a branch, tag or HEAD moves.

## Keybindings (optional)
No default keybindings ship, because JetBrains shortcuts collide with VS Code built-ins
(`Ctrl+K` is VS Code's chord prefix, `Ctrl+T` is "Go to Symbol", `Ctrl+Shift+K` is "Delete Line").
Binding `Ctrl+K` alone disables every `Ctrl+K …` chord in VS Code.
Add the ones you want to your `keybindings.json`:
```json
[
  { "key": "ctrl+shift+`", "command": "jbgit.showBranches" },
  { "key": "ctrl+k",       "command": "jbgit.commit" },
  { "key": "ctrl+t",       "command": "jbgit.updateProject" },
  { "key": "ctrl+shift+k", "command": "jbgit.push" }
]
```

## Settings
- `jbGit.updateMethod`: `merge` (default) or `rebase` for Update Project.
- `jbGit.recentBranchesLimit`: number of recent branches in the popup (default 5).
