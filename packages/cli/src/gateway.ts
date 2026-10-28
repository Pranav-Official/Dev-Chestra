import type { GatewayPort, GatewayScope } from "@devchestra/engine";
import {
  createAgentGateway,
  ExecTokenRegistry,
  OutputValidator,
  startLoopbackServer,
} from "@devchestra/server";
import type { Store } from "@devchestra/store";

export interface RunningGateway {
  port: GatewayPort;
  close: () => Promise<void>;
}

export async function startGateway(store: Store): Promise<RunningGateway> {
  const tokens = new ExecTokenRegistry({
    registerSecret: (token) => store.security.registerSecret(token, "exec-token"),
  });
  const validator = new OutputValidator();
  let port = 0;
  const app = createAgentGateway({
    tokens,
    submissions: store.submissions,
    validator,
    port: () => port,
  });
  const server = await startLoopbackServer(app);
  port = server.port;
  return {
    port: {
      url: server.url,
      issue(scope: GatewayScope) {
        const token = tokens.issue({
          identity: scope.identity,
          toolset: "agent",
          outputSchema: scope.outputSchema,
          outputSchemaHash: scope.outputSchemaHash,
          validationLimit: scope.validationLimit,
          expiresAt: scope.expiresAt,
        });
        return {
          token,
          revoke: (): void => {
            tokens.revoke(token);
          },
        };
      },
    },
    close: async (): Promise<void> => {
      tokens.clear();
      await server.close();
    },
  };
}
