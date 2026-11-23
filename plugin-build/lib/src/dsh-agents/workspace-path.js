/**
 * @module @linxin666/dsh-agents/workspace-path
 *
 * Pure path helper kept free of Host imports so it can be unit-tested without
 * the DeepSeek Harness runtime. {@link agentWorkspacePath} names the one stable
 * directory a resident member owns.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The stable directory a member's own Workspace lives in.
 *
 * A member is a resident assistant, so its 1:1 sessions share one directory for
 * private notes and scratch files instead of following whichever project was
 * touched last. The name is sanitised for the filesystem and bounded so a long
 * display name cannot escape the base directory.
 * @param name - the member's display name or id.
 * @returns the absolute directory for that member's Workspace.
 */
export function agentWorkspacePath(name) {
	const safe = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 60) || 'agent';
	return join(homedir(), '.dsh-marshal', 'agents', safe);
}
