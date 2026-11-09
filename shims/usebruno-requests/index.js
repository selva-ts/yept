// Local stand-in for @usebruno/requests (see package.json). Both helpers are only called when a script uses them.
// The sandbox worker installs bridges on globalThis before each script runs:
// - cookies (__yeptCookies): a copy of the request's cookie jar; changes go back with the result.
// - bru.sendRequest (__yeptSendRequest): asks the main thread to send the request through Yept's runner.
//   @usebruno/js wraps it in QuickJS, adding the callback form and err.status there.
'use strict';

const cookieBridge = () => globalThis.__yeptCookies ?? null;

module.exports = {
  scripting: {
    createSendRequest: () => (requestConfig) => {
      const send = globalThis.__yeptSendRequest;
      if (!send) return Promise.reject(new Error('bru.sendRequest is not available here'));
      return send(requestConfig);
    }
  },
  cookies: {
    jar: () => {
      const b = cookieBridge();
      if (!b) throw new Error('bru.cookies is not available: automatic cookies are turned off in Settings');
      return b.jar();
    },
    getCookiesForUrl: (url) => cookieBridge()?.getCookiesForUrl(url) ?? []
  }
};
