import { query } from "./_generated/server";

// Trivial health check with no db access — if this errors too, the whole
// deployed bundle is broken, not any specific function or table.
export const ping = query({
  args: {},
  handler: async () => "pong",
});
