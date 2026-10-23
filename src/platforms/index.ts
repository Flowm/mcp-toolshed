import type { Platform } from "../core/platform.ts";
import { reddit } from "./reddit/index.ts";

/** Every platform this Worker serves, each at /<id>/mcp. */
export const PLATFORMS: Platform[] = [reddit];
