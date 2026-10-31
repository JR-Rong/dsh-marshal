/** Hard resource ceilings shared by hub and node. They are reject/evict thresholds, not targets. */
export const MAX_FRAME_BYTES = 1_048_576
export const MAX_JSON_DEPTH = 32
export const MAX_INTERACTION_INPUT_BYTES = 4096
export const OFFLINE_QUEUE_MAX_ITEMS = 1000
export const OFFLINE_QUEUE_MAX_BYTES = 8 * 1024 * 1024
export const SYNC_STAGING_DEVICE_MAX_BYTES = 16 * 1024 * 1024
export const SYNC_STAGING_HUB_MAX_BYTES = 64 * 1024 * 1024
export const SSE_MAX_PENDING_BYTES = 4 * 1024 * 1024
export const MIN_TIMEOUT_MS = 15_000
export const MAX_TIMEOUT_MS = 300_000
export const COMMAND_TTL_MS = 30_000
export const JOURNAL_RETENTION_MS = 24 * 60 * 60 * 1000
