import start from '@tanstack/react-start/server-entry';
import { protect } from './lib/access.ts';

// Gate Start and assets alike, including in local development. The nonce is
// created only after Access succeeds and is shared by the CSP header and SSR.
// The verified Access identity is the only identity routes ever see.
export default {
  fetch(request, env) {
    return protect(request, env, async (nonce, identity) => {
      if (new URL(request.url).pathname.startsWith('/assets/')) {
        return env.ASSETS.fetch(request);
      }
      return start.fetch(request, { context: { cloudflare: { env }, nonce, identity } });
    });
  },
} satisfies ExportedHandler<Env>;
