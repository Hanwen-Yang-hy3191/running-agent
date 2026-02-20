// Type shim for @opencode-ai/sdk.
// The published package's exports map references dist/index.d.ts but the
// actual build output lives at dist/src/index.d.ts. This declaration bridges
// the gap so TypeScript can resolve the module.

declare module "@opencode-ai/sdk" {
  export { createOpencode } from "../node_modules/@opencode-ai/sdk/dist/src/index.js";
  export { createOpencodeClient, OpencodeClient } from "../node_modules/@opencode-ai/sdk/dist/src/client.js";
  export { createOpencodeServer } from "../node_modules/@opencode-ai/sdk/dist/src/server.js";
  export type { Event } from "../node_modules/@opencode-ai/sdk/dist/src/gen/types.gen.js";
}
