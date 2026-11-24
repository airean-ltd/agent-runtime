import type { FinalRunStatus, RunEvent, RunLimits, RunSample, RunUsage } from "../contract/events.ts";
import type { SampleUsage, SandboxProvider } from "./sandbox-provider.ts";
import type { SessionStore } from "./session-store.ts";
/** How the run looks to whoever is storing it, answered on every append. */
export type SinkState = {
    /** Someone asked for the run to stop. */
    cancelled: boolean;
    /** The run is no longer there to write to: deleted, or already finished. */
    gone: boolean;
};
export declare const LIVE: SinkState;
/**
 * An output copied out of the sandbox. `kind` is whatever the agent declared,
 * so the sink checks it before storing; the author is always the agent.
 */
export type ArtifactUpload = {
    kind: string;
    fileName: string;
    caption: string;
    mediaType: string;
    sha256: string;
    size: number;
    bytes: Uint8Array;
};
/** A local directory pushed into a new sandbox, read-only to the agent. */
export type Mount = {
    localDir: string;
    remoteDir: string;
    /** Files to hash once uploaded: path inside `remoteDir` -> expected sha256. */
    verify?: Record<string, string>;
    /**
     * Bind `localDir` read-only into the sandbox when it is created instead of
     * copying it, e.g. a Cloud Storage volume the job mounted. Needs a provider
     * that binds directories (Cloud Run); `verify` still hashes the files.
     */
    mounted?: boolean;
};
/** Where executeRun keeps the runner's session between sandboxes. */
export type SessionOptions = {
    store: SessionStore;
    /** Usually the thread's id. */
    key: string;
    /**
     * The session directory in the sandbox. Default `/workspace/.sessions`, where
     * the pi runner keeps it; `/workspace` keeps the whole workspace, as a
     * sandbox service's pause does (see `links` and `exclude`).
     */
    remoteDir?: string;
    /**
     * Keep symlinks, as links the job never follows, for a directory holding a
     * venv or node_modules. The store must keep them too (DirectorySessionStore's
     * `links`). Default false: a session holding one is not saved.
     */
    links?: boolean;
    /**
     * Paths under `remoteDir` left out of the save, such as `outputs`, which the
     * run already copies out, or `.cache`.
     */
    exclude?: readonly string[];
    /** The most a saved session may hold; with `stream`, the archive. Default 256 MiB. */
    maxBytes?: number;
    /**
     * Move the session as one tar archive, packed and unpacked by tar inside
     * the sandboxes and never unpacked on the job, which only stores the bytes.
     * Much faster for a large directory, and it keeps whatever the directory
     * holds (`links` does not apply). Needs a provider with `packDir` and
     * `unpackDir`, a store with `saveArchive` and `archive`, and tar (and gzip)
     * in the image.
     */
    stream?: boolean;
    /** With `stream`, gzip the archive. Default true. */
    gzip?: boolean;
};
export type EventSink = {
    /** Stores a batch in seq order and says whether the run is still wanted. */
    events: (batch: RunEvent[]) => Promise<SinkState>;
    samples: (samples: RunSample[]) => Promise<void>;
    /** Stores an output file and returns its id, which goes into the artifact event. */
    artifact: (upload: ArtifactUpload) => Promise<string | null>;
    log: (message: string) => void;
};
/** Grants and revokes the run's egress-gateway token. */
export type TokenGrant = {
    grant: (runId: string, ttlMs: number) => Promise<string>;
    revoke: (token: string) => Promise<void>;
};
export type RunOutcome = {
    /**
     * The run's sandbox. Null when the run was stopped before it began and was
     * given none to resume, so there is nothing to record or ask a provider about.
     */
    sandboxId: string | null;
    /** True when this run had to build a sandbox rather than resume one. */
    created: boolean;
    status: FinalRunStatus;
    error?: string;
    answerText: string;
    /** Tokens and cost summed over every turn. */
    usage: RunUsage;
    events: RunEvent[];
    /**
     * With `session`: whether a stored session was put in the sandbox, and
     * whether the session was stored again once the runner exited.
     */
    session?: {
        restored: boolean;
        saved: boolean;
    };
};
export type ExecuteRunOptions = {
    provider: SandboxProvider;
    sink: EventSink;
    tokens: TokenGrant;
    runId: string;
    prompt: string;
    /** The runner to start in the sandbox, e.g. `["node", "/opt/runner/runner.js"]`. */
    command: string[];
    image: string;
    limits: RunLimits;
    /** Pushed into a sandbox this run builds; a resumed sandbox already has them. */
    mounts?: Mount[];
    /** Extra labels on a sandbox this run builds. */
    labels?: Record<string, string>;
    /** LLM_PROVIDER, LLM_MODEL, LLM_BASE_URL and anything else the runner reads. */
    env?: Record<string, string>;
    /** A sandbox to continue, from this thread's `sandboxes` row. */
    resumeSandboxId?: string;
    /** Pause the sandbox instead of destroying it, so the thread can reuse it. */
    keepSandbox?: boolean;
    /**
     * Restores the session into a sandbox this run builds, before the runner
     * starts, and saves it once the runner has exited, however the run ended.
     * For a provider that cannot pause, such as Cloud Run; a resumed sandbox
     * still has its session and is not restored into.
     */
    session?: SessionOptions;
    /** Called once the run has a sandbox ready, resumed or newly built, before the runner starts. */
    onSandbox?: (sandboxId: string, created: boolean) => void | Promise<void>;
    /** Reads the sandbox's CPU and memory; omit to store no samples. */
    usage?: SampleUsage;
    /** Cancels the run from outside, e.g. when the dispatcher is shutting down. */
    signal?: AbortSignal;
    batchMs?: number;
    batchEvents?: number;
    sampleMs?: number;
    /** How many times a failed batch is re-sent before the run is abandoned. */
    retries?: number;
    retryMs?: number;
};
/** The most an output, or a saved session, may be; anything larger is not stored. */
export declare const MAX_OUTPUT_BYTES: number;
export declare function mediaTypeFor(fileName: string): string;
/** Merges consecutive text deltas, which the UI concatenates anyway. */
export declare function coalesce(batch: readonly RunEvent[]): RunEvent[];
export declare const SESSION_DIR = "/workspace/.sessions";
/**
 * Run in the sandbox as the runner's user, so the restored files are the
 * runner's to append to: `sh -c SESSION_RESTORE_SCRIPT sh <staged> <sessionDir>`.
 */
export declare const SESSION_RESTORE_SCRIPT = "mkdir -p \"$2\" && cp -R \"$1\"/. \"$2\"/; code=$?; rm -rf \"$1\" 2>/dev/null; exit $code";
export declare function executeRun(opts: ExecuteRunOptions): Promise<RunOutcome>;
