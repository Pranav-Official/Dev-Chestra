/** Persisted runtime identity and per-invocation mount contract. */
export interface ContainerRuntime {
  version: 1;
  bin: "podman" | "docker";
  image: string;
  uid: number;
  gid: number;
  selinux: boolean;
  owner: string;
  endpoint: string;
}
export interface ContainerExecution {
  runtime: ContainerRuntime;
  dataDir: string;
  runId: string;
  executionId: string;
  cwd: string;
  mounts?: { source: string; target: string; readOnly?: boolean }[];
  homeVolume?: string;
  network?: boolean;
  readOnlyWorkspace?: boolean;
}
