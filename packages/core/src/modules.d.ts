// The @usebruno/* packages we use ship without usable type declarations; the engine wraps them in typed adapters.
declare module '@usebruno/filestore';
declare module '@usebruno/js';
declare module '@usebruno/converters';
// follow-redirects ships no types; the engine only uses its http/https request functions.
declare module 'follow-redirects' {
  import type { ClientRequest, IncomingMessage } from 'node:http';
  type Request = (options: object, cb: (res: IncomingMessage) => void) => ClientRequest;
  const followRedirects: { http: { request: Request }; https: { request: Request } };
  export default followRedirects;
}
