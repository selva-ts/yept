// Type hints for the script editors. Covers the commonly used part of Bruno's script API.
export const BRU_SCRIPT_TYPES = `
interface BrunoRequest {
  getUrl(): string; setUrl(url: string): void;
  getMethod(): string; setMethod(method: string): void;
  getHeader(name: string): string | undefined; getHeaders(): Record<string, string>;
  setHeader(name: string, value: string): void; setHeaders(headers: Record<string, string>): void; deleteHeader(name: string): void;
  getBody(): any; setBody(body: any): void;
  getTimeout(): number; setTimeout(ms: number): void;
}
interface BrunoResponse {
  /** HTTP status code. */
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Parsed JSON body (or text). */
  body: any;
  responseTime: number;
  getStatus(): number; getStatusText(): string;
  getHeader(name: string): string | undefined; getHeaders(): Record<string, string>;
  getBody(): any; getResponseTime(): number;
}
interface Bru {
  /** Runtime variable for the active environment (this app session). */
  getVar(name: string): any; setVar(name: string, value: any): void; deleteVar(name: string): void; hasVar(name: string): boolean;
  /** Environment variable. Changes last for this app session; secret names are stored as local secrets. */
  getEnvVar(name: string): any; setEnvVar(name: string, value: any): void; deleteEnvVar(name: string): void; hasEnvVar(name: string): boolean;
  getEnvName(): string;
  getCollectionVar(name: string): any; getFolderVar(name: string): any; getRequestVar(name: string): any;
  getProcessEnv(name: string): string | undefined;
  interpolate(text: string): string;
  sleep(ms: number): Promise<void>;
  setNextRequest(name: string | null): void;
  /**
   * Sends another request through Yept (same TLS settings and cookie jar), at most 10 per script, within the
   * script's time limit. Rejects (or calls back with err) for a non-2xx status or no response.
   */
  sendRequest(options: string | BrunoSendRequestOptions): Promise<BrunoSendResponse>;
  sendRequest(options: string | BrunoSendRequestOptions, callback: (err: BrunoSendError | null, res: BrunoSendResponse | null) => void | Promise<void>): Promise<BrunoSendResponse | undefined>;
}
interface BrunoSendRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** An object is sent as JSON, or as a form when Content-Type is application/x-www-form-urlencoded or multipart/form-data. */
  data?: any;
  params?: Record<string, string | number>;
  auth?: { username: string; password: string };
  /** Milliseconds; the app's default when not set. */
  timeout?: number;
  maxRedirects?: number;
  baseURL?: string;
}
interface BrunoSendResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  /** Parsed JSON body (or text). */
  data: any;
  responseTime: number;
}
interface BrunoSendError {
  message: string;
  code?: string;
  /** HTTP status, when there was a response. */
  status?: number;
  response?: BrunoSendResponse;
}
declare const req: BrunoRequest;
declare const res: BrunoResponse;
declare const bru: Bru;
declare function test(name: string, fn: () => void | Promise<void>): void;
declare const expect: any;
`;
