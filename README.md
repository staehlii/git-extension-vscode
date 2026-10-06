# Git (JetBrains style) for VS Code

Internal extension that brings the JetBrains Git workflow to VS Code. Built in phases (see plan).

## Status
- [x] Phase 1: scaffold, git CLI wrapper, repo tracking, `jbgit:` revision documents, Git Console (output channel)
- [x] Phase 2: Branches popup + status-bar branch widget, Update Project, Push dialog, Smart Checkout, Continue/Abort
- [ ] Phase 3: Commit window + changelists
- [ ] Phase 4: Git Log graph
- [ ] Phase 5: Conflicts view + interactive rebase

## Run
```
npm install
npm run build      # or: npm run watch
npm test           # typecheck + unit tests
```
Press F5 in VS Code ("Run Extension") to open an Extension Development Host.

## Keybindings (optional)
No default keybindings ship, because JetBrains shortcuts collide with VS Code built-ins
(`Ctrl+K` is VS Code's chord prefix, `Ctrl+T` is "Go to Symbol", `Ctrl+Shift+K` is "Delete Line").
Add the ones you want to your `keybindings.json`:
```json
[
  { "key": "ctrl+shift+`", "command": "jbgit.showBranches" },
  { "key": "ctrl+t",       "command": "jbgit.updateProject" },
  { "key": "ctrl+shift+k", "command": "jbgit.push" }
]
```

## Settings
- `jbGit.updateMethod`: `merge` (default) or `rebase` for Update Project.
- `jbGit.recentBranchesLimit`: number of recent branches in the popup (default 5).
