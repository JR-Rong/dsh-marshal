import { spawn } from 'node:child_process';
/**
 * 通用子进程监督器：不包含 Codex/Claude 协议，只负责代次、stdio 生命周期、
 * 重启退避、停止清理与 stderr 有界诊断。
 *
 * 关键不变量：
 * - generation 单调递增；旧代次的响应、退出回调一律忽略。
 * - 退出/停止/取消分别以 `exited` / `stopped` / `aborted` 拒绝该代次的 pending RPC。
 * - 退避 1/2/4/8/16/30 秒封顶；默认 60 秒窗口最多 5 次启动，超出进入 failed，
 *   由显式 recover() 或调用方在 retryAt 之后重试。
 * - 认证/配置错误由注入的 classify(error) 判定，不循环重启。
 * - stop() 先禁用重启再清理；幂等，停止后零重启。
 * - stderr 只保留有界本机内存；`stderr()` 快照仅供本机诊断，绝不能发往 hub 或写日志。
 * - POSIX 用 detached 进程组 + kill(-pid, SIGTERM)，超时 SIGKILL；Windows 走注入的
 *   taskkill /T /F 式终止。平台分支通过注入实现，不做未经验证的假设。
 */
export const SUPERVISOR_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
export const SUPERVISOR_RESTART_WINDOW_MS = 60_000;
export const SUPERVISOR_MAX_STARTS = 5;
export const SUPERVISOR_RETRY_AFTER_MS = 300_000;
export const SUPERVISOR_STDERR_LIMIT_BYTES = 16 * 1024;
export const SUPERVISOR_KILL_GRACE_MS = 5_000;
export class SupervisorError extends Error {
    name = 'SupervisorError';
    code;
    generation;
    constructor(code, generation) {
        super(`marshal: supervisor ${code}`);
        this.code = code;
        this.generation = generation;
    }
}
function createDefaultClock() {
    return {
        now: () => Date.now(),
        setTimeout(callback, ms) {
            const timer = setTimeout(callback, ms);
            timer.unref();
            return { id: timer };
        },
        clearTimeout(handle) {
            clearTimeout(handle.id);
        },
    };
}
const defaultSpawn = (command, args, options) => spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    detached: options.detached,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: options.windowsHide,
});
function groupSignal(child, signal) {
    const pid = child.pid;
    if (pid !== undefined) {
        try {
            process.kill(-pid, signal);
            return;
        }
        catch {
            // 进程组已不存在或不是 leader：退回直接 kill，仍以子进程为准。
        }
    }
    try {
        child.kill(signal);
    }
    catch { /* 已退出 */ }
}
export function createPosixTerminator() {
    return {
        terminate: child => groupSignal(child, 'SIGTERM'),
        kill: child => groupSignal(child, 'SIGKILL'),
    };
}
export function createWindowsTerminator(taskkill) {
    const run = (child) => {
        const pid = child.pid;
        if (pid === undefined)
            return;
        try {
            taskkill(pid);
        }
        catch { /* best effort */ }
    };
    // taskkill /T /F 没有温和阶段；两次调用幂等，只是保证 stop/reclaim 路径一致。
    return { terminate: run, kill: run };
}
function defaultTaskkill(pid) {
    try {
        const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
        });
        child.on('error', () => { });
        child.unref();
    }
    catch {
        // 没有 taskkill 时不阻塞宿主；调用方仍可依赖子进程自身退出。
    }
}
function createDefaultTerminator(platform, taskkill) {
    return platform === 'win32' ? createWindowsTerminator(taskkill) : createPosixTerminator();
}
/** 只保留末尾 limit 字节；`dropped` 记录被截掉的字节数。 */
class BoundedBuffer {
    limit;
    chunks = [];
    total = 0;
    dropped = 0;
    constructor(limit) {
        this.limit = limit;
    }
    append(chunk) {
        if (chunk.length === 0)
            return;
        if (chunk.length >= this.limit) {
            this.dropped += this.total + chunk.length - this.limit;
            this.chunks.length = 0;
            this.chunks.push(chunk.subarray(chunk.length - this.limit));
            this.total = this.limit;
            return;
        }
        this.chunks.push(chunk);
        this.total += chunk.length;
        while (this.total > this.limit) {
            const first = this.chunks[0];
            if (first === undefined)
                break;
            const over = this.total - this.limit;
            if (first.length <= over) {
                this.chunks.shift();
                this.total -= first.length;
                this.dropped += first.length;
            }
            else {
                this.chunks[0] = first.subarray(over);
                this.total -= over;
                this.dropped += over;
            }
        }
    }
    snapshot() {
        return {
            bytes: this.total,
            truncated: this.dropped > 0,
            text: Buffer.concat(this.chunks).toString('utf8'),
        };
    }
}
export function createSupervisor(options) {
    const clock = options.clock ?? createDefaultClock();
    const spawnFn = options.spawn ?? defaultSpawn;
    const platform = options.platform ?? process.platform;
    const terminator = options.terminator
        ?? createDefaultTerminator(platform, options.taskkill ?? defaultTaskkill);
    const classify = options.classify ?? (() => 'retryable');
    const stderrLimit = Math.max(1, options.stderrLimitBytes ?? SUPERVISOR_STDERR_LIMIT_BYTES);
    const killGraceMs = Math.max(0, options.killGraceMs ?? SUPERVISOR_KILL_GRACE_MS);
    const windowMs = Math.max(1, options.restartWindowMs ?? SUPERVISOR_RESTART_WINDOW_MS);
    const maxStarts = Math.max(1, options.maxStartsPerWindow ?? SUPERVISOR_MAX_STARTS);
    const retryAfterMs = Math.max(0, options.retryAfterMs ?? SUPERVISOR_RETRY_AFTER_MS);
    const launchArgs = options.args ?? [];
    let state = 'idle';
    let generation = 0;
    let child;
    let listeners;
    let stopped = false;
    let stopPromise;
    let restartTimer;
    let graceTimer;
    let nextRestartAt;
    let restartIndex = 0;
    let restartCount = 0;
    let failureReason;
    let retryAt;
    let lastExit;
    let starts = [];
    let stderrBuffer = new BoundedBuffer(stderrLimit);
    const pending = new Map();
    let nextPendingId = 1;
    function clearRestartTimer() {
        if (restartTimer === undefined)
            return;
        clock.clearTimeout(restartTimer);
        restartTimer = undefined;
        nextRestartAt = undefined;
    }
    function clearGraceTimer() {
        if (graceTimer === undefined)
            return;
        clock.clearTimeout(graceTimer);
        graceTimer = undefined;
    }
    function scheduleGraceKill(proc) {
        clearGraceTimer();
        graceTimer = clock.setTimeout(() => {
            graceTimer = undefined;
            try {
                terminator.kill(proc);
            }
            catch { /* best effort */ }
        }, killGraceMs);
    }
    function rejectPending(reason) {
        const entries = [...pending.values()];
        pending.clear();
        for (const entry of entries) {
            entry.detach();
            entry.controller.abort();
            entry.reject(new SupervisorError(reason, entry.generation));
        }
    }
    function detach(proc) {
        const attached = listeners;
        if (attached === undefined || attached.proc !== proc)
            return;
        listeners = undefined;
        try {
            proc.removeListener('exit', attached.exit);
        }
        catch { /* 已移除 */ }
        try {
            proc.removeListener('error', attached.error);
        }
        catch { /* 已移除 */ }
        try {
            proc.stderr?.removeListener('data', attached.data);
        }
        catch { /* 已移除 */ }
    }
    function teardown(gen, reason, rejectAs) {
        if (gen !== generation)
            return;
        const proc = child;
        child = undefined;
        if (proc !== undefined)
            detach(proc);
        clearGraceTimer();
        rejectPending(rejectAs);
        options.onExit?.(gen, reason);
    }
    function enterFailed(reason) {
        clearRestartTimer();
        state = 'failed';
        failureReason = { reason };
        // 只有重启风暴需要 5 分钟冷却；认证/配置错误要求显式恢复。
        retryAt = reason === 'restart-exhausted' ? clock.now() + retryAfterMs : undefined;
    }
    function pruneStarts(now) {
        starts = starts.filter(at => now - at < windowMs);
    }
    function scheduleRestart() {
        if (stopped || restartTimer !== undefined)
            return;
        const index = Math.min(restartIndex, SUPERVISOR_BACKOFF_MS.length - 1);
        const delay = SUPERVISOR_BACKOFF_MS[index] ?? 30_000;
        restartIndex += 1;
        restartCount += 1;
        state = 'backoff';
        nextRestartAt = clock.now() + delay;
        restartTimer = clock.setTimeout(() => {
            restartTimer = undefined;
            nextRestartAt = undefined;
            attemptStart();
        }, delay);
    }
    function onProcessEnd(gen, code, signal, error) {
        if (gen !== generation || child === undefined)
            return;
        const reason = error === undefined ? 'exited' : 'spawn-failed';
        teardown(gen, reason, 'exited');
        lastExit = {
            generation: gen,
            reason,
            at: clock.now(),
            code,
            signal,
        };
        if (stopped) {
            state = 'stopped';
            return;
        }
        const kind = error === undefined ? 'retryable' : classify(error);
        if (kind === 'retryable') {
            scheduleRestart();
        }
        else {
            enterFailed(kind === 'config' ? 'config-invalid' : 'terminal-failure');
        }
    }
    function attach(gen, proc) {
        const exit = (code, signal) => {
            onProcessEnd(gen, code, signal);
        };
        const error = (spawnError) => {
            onProcessEnd(gen, null, null, spawnError);
        };
        const data = (chunk) => {
            if (Buffer.isBuffer(chunk))
                stderrBuffer.append(chunk);
            else if (typeof chunk === 'string')
                stderrBuffer.append(Buffer.from(chunk));
        };
        proc.on('exit', exit);
        proc.on('error', error);
        proc.stderr?.on('data', data);
        listeners = { proc, exit, error, data };
    }
    function attemptStart() {
        if (stopped || child !== undefined)
            return false;
        const now = clock.now();
        pruneStarts(now);
        if (starts.length >= maxStarts) {
            enterFailed('restart-exhausted');
            return false;
        }
        clearRestartTimer();
        starts.push(now);
        generation += 1;
        const gen = generation;
        stderrBuffer = new BoundedBuffer(stderrLimit);
        failureReason = undefined;
        retryAt = undefined;
        state = 'starting';
        let proc;
        try {
            proc = spawnFn(options.command, launchArgs, {
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options.env === undefined ? {} : { env: options.env }),
                detached: platform !== 'win32',
                windowsHide: true,
            });
        }
        catch (error) {
            lastExit = { generation: gen, reason: 'spawn-failed', at: now };
            options.onExit?.(gen, 'spawn-failed');
            const kind = classify(error);
            if (kind === 'retryable')
                scheduleRestart();
            else
                enterFailed(kind === 'config' ? 'config-invalid' : 'terminal-failure');
            return false;
        }
        child = proc;
        attach(gen, proc);
        return true;
    }
    function isCurrent(gen) {
        return !stopped
            && child !== undefined
            && gen === generation
            && (state === 'starting' || state === 'running');
    }
    function busyNow() {
        if (pending.size > 0)
            return true;
        if (options.busy === undefined)
            return true;
        try {
            return options.busy() !== false;
        }
        catch {
            return true;
        }
    }
    function terminateCurrent() {
        const proc = child;
        if (proc === undefined)
            return;
        child = undefined;
        detach(proc);
        clearGraceTimer();
        try {
            terminator.terminate(proc);
        }
        catch { /* best effort */ }
        scheduleGraceKill(proc);
    }
    const canReclaim = () => !stopped && child !== undefined && !busyNow();
    return {
        get generation() { return generation; },
        get state() { return state; },
        get pending() { return pending.size; },
        start() {
            if (stopped || child !== undefined)
                return false;
            if (state === 'starting' || state === 'running' || state === 'backoff')
                return false;
            if (state === 'failed' && (retryAt === undefined || clock.now() < retryAt))
                return false;
            return attemptStart();
        },
        recover() {
            if (stopped || state !== 'failed' || child !== undefined)
                return false;
            // 显式恢复被视为新一次监督窗口：清空历史启动计数，允许人工立即重试。
            starts = [];
            restartIndex = 0;
            failureReason = undefined;
            retryAt = undefined;
            state = 'idle';
            return attemptStart();
        },
        markReady() {
            if (child === undefined || stopped)
                return;
            state = 'running';
            restartIndex = 0;
            failureReason = undefined;
            retryAt = undefined;
        },
        fail(error) {
            if (stopped)
                return;
            const kind = classify(error);
            if (child !== undefined) {
                const gen = generation;
                terminateCurrent();
                rejectPending('exited');
                options.onExit?.(gen, 'exited');
            }
            if (kind === 'retryable') {
                if (child === undefined)
                    scheduleRestart();
            }
            else {
                enterFailed(kind === 'config' ? 'config-invalid' : 'terminal-failure');
            }
        },
        request(operation, requestOptions) {
            if (stopped || child === undefined || (state !== 'starting' && state !== 'running')) {
                return Promise.reject(new SupervisorError('not-running', generation));
            }
            const gen = generation;
            const controller = new AbortController();
            const id = nextPendingId++;
            const external = requestOptions?.signal;
            return new Promise((resolve, reject) => {
                let settled = false;
                const detachExternal = () => {
                    external?.removeEventListener('abort', onExternalAbort);
                };
                const entry = {
                    generation: gen,
                    controller,
                    detach: detachExternal,
                    reject,
                };
                const settle = () => {
                    if (settled)
                        return false;
                    settled = true;
                    detachExternal();
                    return pending.delete(id);
                };
                function onExternalAbort() {
                    if (settled)
                        return;
                    settled = true;
                    detachExternal();
                    pending.delete(id);
                    controller.abort();
                    reject(new SupervisorError('aborted', gen));
                }
                pending.set(id, entry);
                external?.addEventListener('abort', onExternalAbort, { once: true });
                if (external?.aborted === true) {
                    onExternalAbort();
                    return;
                }
                let running;
                try {
                    running = operation({ generation: gen, signal: controller.signal });
                }
                catch (error) {
                    if (settle())
                        reject(error);
                    return;
                }
                running.then(value => {
                    if (!settle())
                        return; // 迟到响应：该代次已被拒绝/移除，直接忽略
                    if (!isCurrent(gen)) {
                        reject(new SupervisorError('stale-generation', gen));
                        return;
                    }
                    resolve(value);
                }, error => {
                    if (!settle())
                        return;
                    reject(error);
                });
            });
        },
        isCurrent,
        canReclaim,
        async reclaim() {
            if (!canReclaim())
                return false;
            // 任何 await 之前再检查一次，避免 busy 在竞态中变为 true。
            if (busyNow())
                return false;
            const proc = child;
            if (proc === undefined)
                return false;
            const gen = generation;
            terminateCurrent();
            rejectPending('stopped');
            options.onExit?.(gen, 'stopped');
            lastExit = { generation: gen, reason: 'stopped', at: clock.now() };
            state = 'stopped';
            failureReason = { reason: 'idle-reclaimed' };
            return true;
        },
        transport() {
            if (child === undefined)
                return undefined;
            return { generation, stdin: child.stdin, stdout: child.stdout };
        },
        health() {
            return {
                state,
                generation,
                pending: pending.size,
                restarts: restartCount,
                ...(failureReason === undefined ? {} : { reason: failureReason }),
                ...(retryAt === undefined ? {} : { retryAt }),
                ...(nextRestartAt === undefined ? {} : { nextRestartAt }),
                ...(lastExit === undefined ? {} : { lastExit }),
            };
        },
        stderr() {
            const snapshot = stderrBuffer.snapshot();
            return { generation, ...snapshot };
        },
        stop() {
            if (stopPromise !== undefined)
                return stopPromise;
            // 先禁用重启，再做任何清理/信号，避免退出事件触发新启动。
            stopped = true;
            clearRestartTimer();
            const proc = child;
            if (proc !== undefined) {
                const gen = generation;
                child = undefined;
                detach(proc);
                clearGraceTimer();
                rejectPending('stopped');
                options.onExit?.(gen, 'stopped');
                lastExit = { generation: gen, reason: 'stopped', at: clock.now() };
                try {
                    terminator.terminate(proc);
                }
                catch { /* best effort */ }
                scheduleGraceKill(proc);
            }
            else {
                rejectPending('stopped');
            }
            failureReason = undefined;
            retryAt = undefined;
            state = 'stopped';
            stopPromise = Promise.resolve();
            return stopPromise;
        },
    };
}
