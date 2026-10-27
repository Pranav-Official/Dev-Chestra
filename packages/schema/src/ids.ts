/**
 * Managed workflow file ids (the file stem under `.relay/workflows/`). This is
 * deliberately stricter than generic URL ids: no dots, underscores or uppercase.
 */
export const WORKFLOW_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/** Hard cap for a workflow file, enforced by the API, server and serializer. */
export const MAX_WORKFLOW_FILE_BYTES = 1024 * 1024;

/** Node ids are JSONata-safe because node ids name values in scope. */
export const NODE_ID_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/** Gate branch and join input handles are referenced as 'nodeId.handle'. */
export const HANDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
