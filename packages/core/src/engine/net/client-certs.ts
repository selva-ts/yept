// Client certificates (mutual TLS): which certificate a host gets, and reading the files for a run. The files stay
// where the user keeps them; only their paths are in the local TLS settings, and passphrases in the encrypted store.
import { promises as fs } from 'node:fs';
import tls from 'node:tls';
import type { ClientCertificate } from '../../shared/model';

/** A client certificate read from disk, ready for a TLS connection. */
export interface LoadedClientCertificate {
  host: string;
  pfx?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
}

export class ClientCertificateError extends Error {}

/**
 * Whether a host pattern covers host:port. `api.example.test` is that host only, `*.example.test` its subdomains,
 * `*` inside a pattern any characters, and `:port` limits it to one port.
 */
export function hostMatches(pattern: string, host: string, port: number): boolean {
  let p = pattern.trim().toLowerCase();
  if (!p) return false;
  const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(p);
  if (withPort) {
    if (Number(withPort[2]) !== port) return false;
    p = withPort[1];
  }
  p = p.replace(/^\[|\]$/g, '');
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!p.includes('*')) return h === p;
  const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^]*')}$`);
  return re.test(h);
}

/** The first certificate whose pattern covers host:port. */
export function certificateFor<T extends { host: string }>(list: T[] | undefined, host: string, port: number): T | undefined {
  return list?.find((c) => hostMatches(c.host, host, port));
}

/** Plain words for what OpenSSL (Node) or BoringSSL (Electron) says about a certificate or key it can't use. */
function explain(e: Error, c: ClientCertificate, passphrase: string | undefined): string {
  const m = e.message;
  if (/mac verify failure|bad decrypt|bad password|BAD_DECRYPT|INCORRECT_PASSWORD|interrupted or cancelled|PKCS12_parse/i.test(m)) {
    return passphrase ? 'the passphrase is wrong' : 'it needs a passphrase';
  }
  if (/key values mismatch|KEY_VALUES_MISMATCH/i.test(m)) return "the key doesn't belong to the certificate";
  if (/no start line|NO_START_LINE|bad base64|unsupported/i.test(m)) {
    return c.pfxFile ? "it isn't a PFX (PKCS#12) file" : "the certificate or key isn't in PEM format";
  }
  if (/not enough data|wrong tag|header too long|nested asn1|BAD_PKCS12_DATA|DECODE_ERROR|BAD_ENCODING/i.test(m)) return c.pfxFile ? "it isn't a PFX (PKCS#12) file" : 'the file is damaged';
  return m;
}

async function read(path: string, what: string, host: string): Promise<Buffer> {
  try {
    return await fs.readFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new ClientCertificateError(`Can't read the client ${what} for ${host} (${path}): ${code === 'ENOENT' ? 'the file is missing' : (e as Error).message}`);
  }
}

/** Reads and checks each certificate, so a wrong passphrase or a mismatched key stops the send with an explanation. */
export async function loadClientCertificates(list: ClientCertificate[], passphrases: Record<string, string>): Promise<LoadedClientCertificate[]> {
  const out: LoadedClientCertificate[] = [];
  for (const c of list) {
    const host = c.host.trim();
    if (!host) continue;
    const passphrase = passphrases[host] || undefined;
    let loaded: LoadedClientCertificate;
    if (c.pfxFile) {
      loaded = { host, pfx: await read(c.pfxFile, 'certificate', host), passphrase };
    } else if (c.certFile && c.keyFile) {
      loaded = { host, cert: await read(c.certFile, 'certificate', host), key: await read(c.keyFile, 'key', host), passphrase };
    } else {
      throw new ClientCertificateError(`The client certificate for ${host} needs ${c.certFile ? 'its key file' : 'a certificate file'}`);
    }
    try {
      tls.createSecureContext({ pfx: loaded.pfx, cert: loaded.cert, key: loaded.key, passphrase });
    } catch (e) {
      throw new ClientCertificateError(`Can't use the client certificate for ${host}: ${explain(e as Error, c, passphrase)}`);
    }
    out.push(loaded);
  }
  return out;
}
