# dsh-marshal plugin snapshot

This directory is the current installed build of the marshal plugin, including:

- agent workspaces (`Agent · 名字`) and workspace identity;
- resident agent sessions, edit/delete, private chat and cross-workspace sessions;
- local group chat with @mentions, group task cards and dispatch;
- hub-side cross-device groups (`hub/cross-groups.js`) with streaming deltas,
  session prompt routing and persistence;
- the 调度官 client panel (agents, groups, cross-device, quick nav).

It is a self-contained DSH plugin package: install it from this directory
with `dsh plugin --profile <profile> add ./plugin-build`, or copy
`lib/`, `client/` and `cordis.patch.yml` into a plugin directory.

The root TypeScript `src/` tree is the historical core; this snapshot adds
the agent/group work that was developed directly in the installed plugin,
where the source had diverged. Porting these modules back into `src/` is
tracked separately.
