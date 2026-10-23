import { createRouter } from "./core/platform.ts";
import { PLATFORMS } from "./platforms/index.ts";

export default {
  fetch: createRouter(PLATFORMS),
} satisfies ExportedHandler<Env>;
