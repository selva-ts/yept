import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

let cached: string[] | null = null;

/**
 * Self-signed trust anchors from Node's defaults (including NODE_EXTRA_CA_CERTS) and the OS store,
 * so a trusted ASP.NET dev cert or corporate root works without extra setup.
 */
export function caCertificates(): string[] {
  cached ??= trustAnchors([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
  return cached;
}

/**
 * The trust anchors in a CA file chosen for an environment. Throws instead of ignoring the file
 * when no certificate in it can be trusted.
 */
export function caFileAnchors(pem: string): string[] {
  if (!pem.match(PEM)) throw new Error('it contains no PEM certificates (-----BEGIN CERTIFICATE-----)');
  const anchors = trustAnchors([pem], true);
  if (!anchors.length) throw new Error('it contains no self-signed root certificate for TLS server authentication. Include the root CA, not only an intermediate');
  return anchors;
}

function trustAnchors(certificates: string[], strict = false): string[] {
  const anchors = new Map<string, string>();
  for (const pem of certificates) {
    for (const block of pem.match(PEM) ?? []) {
      // System stores can contain certificates or legacy keys unsupported by the current runtime.
      try {
        const cert = new X509Certificate(block);
        if (anchors.has(cert.fingerprint256) || cert.subject !== cert.issuer) continue;
        // When an extended key usage is present, require TLS server authentication.
        if (cert.keyUsage && !cert.keyUsage.includes('1.3.6.1.5.5.7.3.1')) continue;
        if (cert.verify(cert.publicKey)) anchors.set(cert.fingerprint256, cert.toString());
      } catch (e) {
        if (strict) throw new Error(`a certificate in it can't be read: ${(e as Error).message}`);
      }
    }
  }
  return [...anchors.values()];
}

export function caOptions(extra: string[] = []): tls.SecureContextOptions {
  // BoringSSL needs partial chains for trusted server certs without keyCertSign.
  // Keep cached intermediates out: they must chain to a trusted self-signed anchor.
  return { ca: [...new Set([...caCertificates(), ...trustAnchors(extra)])], allowPartialTrustChain: true };
}
