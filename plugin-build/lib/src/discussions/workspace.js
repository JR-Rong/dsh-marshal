import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DiscussionError } from "./types.js";
const within = (parent, path) => {
    const rel = relative(parent, path);
    return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
};
/** Canonical leases include symlink aliases and ancestor/descendant directories. */
export function createWorkspaceLeases() {
    const active = new Set();
    return {
        acquire(requested) {
            let workspace;
            try {
                if (!isAbsolute(requested))
                    throw new Error();
                workspace = realpathSync(requested);
                if (!statSync(workspace).isDirectory())
                    throw new Error();
            }
            catch {
                throw new DiscussionError('invalid-workspace');
            }
            const home = realpathSync(homedir());
            if (within(workspace, home) || ['.ssh', '.codex', '.dsh', '.dsh-marshal'].some(name => within(join(home, name), workspace))) {
                throw new DiscussionError('invalid-workspace');
            }
            if ([...active].some(path => within(path, workspace) || within(workspace, path)))
                throw new DiscussionError('writer-busy');
            active.add(workspace);
            return { workspace, release() { active.delete(workspace); } };
        },
    };
}
