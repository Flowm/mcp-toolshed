// Make `env` (and the pool-workers `ProvidedEnv`) carry the Worker's bindings.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

declare namespace Cloudflare {
  interface Env {
    /**
     * Repository named in the User-Agent (see src/core/client.ts). Deploys set it with --var: CI passes its own
     * repository. It is not in wrangler.jsonc, so the Deploy to Cloudflare setup page does not ask for it.
     */
    REPOSITORY_URL?: string;
  }
}
