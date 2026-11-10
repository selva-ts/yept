// Auth that needs a second send: the server answers the first one with 401 and a challenge, and the request goes
// again with an Authorization header computed from it. Digest needs one round trip; NTLM needs its three messages
// on one connection, so the runner gives it a connection of its own.
import type { AuthConfig } from '../../shared/model';
import { DigestError, digestAuthorization, parseDigestChallenges, pickChallenge } from './digest';
import { NtlmError, authenticateMessage, negotiateMessage, ntlmChallengeFrom } from './ntlm';

export class ChallengeError extends Error {}

export interface ChallengeAuth {
  name: 'Digest' | 'NTLM';
  /** Authorization for the first send: NTLM starts its handshake there; Digest sends none. */
  initial?: string;
  /** NTLM: all sends on one kept-alive connection. */
  sameConnection: boolean;
  /**
   * Authorization for the second send, from the 401's WWW-Authenticate value; null when it holds no challenge for
   * this scheme (the 401 is then the answer). Throws a ChallengeError for a challenge Yept can't answer.
   */
  answer(wwwAuthenticate: string, method: string, url: string): string | null;
}

/** For Digest and NTLM auth, with variables already filled in by `I`; null for every other mode. */
export function challengeAuth(auth: AuthConfig, I: (s: string) => string): ChallengeAuth | null {
  if (auth.mode === 'digest') {
    const username = I(auth.digest.username);
    const password = I(auth.digest.password);
    return {
      name: 'Digest',
      sameConnection: false,
      answer: (header, method, url) => {
        const all = parseDigestChallenges(header);
        if (!all.length) return null;
        try {
          const u = new URL(url);
          return digestAuthorization(pickChallenge(all), { username, password, method, uri: `${u.pathname}${u.search}` });
        } catch (e) {
          if (e instanceof DigestError) throw new ChallengeError(e.message);
          throw e;
        }
      }
    };
  }
  if (auth.mode === 'ntlm') {
    const creds = { username: I(auth.ntlm.username), password: I(auth.ntlm.password), domain: I(auth.ntlm.domain) };
    return {
      name: 'NTLM',
      initial: `NTLM ${negotiateMessage()}`,
      sameConnection: true,
      answer: (header) => {
        const challenge = ntlmChallengeFrom(header);
        if (!challenge) return null;
        try {
          return `NTLM ${authenticateMessage(challenge, creds)}`;
        } catch (e) {
          if (e instanceof NtlmError) throw new ChallengeError(e.message);
          throw e;
        }
      }
    };
  }
  return null;
}
