import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentWorkspacePath } from '../lib/src/dsh-agents/workspace-path.js';

const source = readFileSync(new URL('../lib/src/dsh-agents/index.js', import.meta.url), 'utf8');

test('a member gets one stable Workspace directory of its own', () => {
    assert.equal(agentWorkspacePath('丞相'), join(homedir(), '.dsh-marshal', 'agents', '丞相'));
    // A display name must never escape the agents base directory.
    assert.equal(agentWorkspacePath('../../etc/passwd'), join(homedir(), '.dsh-marshal', 'agents', '..-..-etc-passwd'));
    assert.equal(agentWorkspacePath('a/b\\c:d*e?f"g<h>i|j'), join(homedir(), '.dsh-marshal', 'agents', 'a-b-c-d-e-f-g-h-i-j'));
    assert.equal(agentWorkspacePath('   '), join(homedir(), '.dsh-marshal', 'agents', 'agent'));
    assert.equal(agentWorkspacePath('x'.repeat(200)).split('/').at(-1).length, 60);
    assert.equal(agentWorkspacePath('nul\u0000byte'), join(homedir(), '.dsh-marshal', 'agents', 'nul-byte'));
});

test('a member run joins its own Workspace before falling back to recency', () => {
    assert.match(source, /team\.workspaceId === void 0\s*\n\s*\? \(await this\.agentWorkspaceId\(member\) \?\? this\.recentWorkspaceId\(\)\)\s*\n\s*: this\.resolveWorkspacePin\(team\)/);
    assert.match(source, /async ensureWorkspace\(path\) \{\s*\n\s*const result = await call\("workspace", "create", \{ path \}\);/);
});
