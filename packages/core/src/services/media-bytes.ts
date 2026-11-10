// Response bytes for the image and PDF preview, as base64 (both the Electron and the webview transports carry it).
import { MEDIA_PREVIEW_MAX_BYTES } from '@yept/core/shared/response-file';

export function mediaBytes(body: Buffer | undefined): string {
  if (!body) throw new Error('This response is no longer available. Send the request again.');
  if (body.length > MEDIA_PREVIEW_MAX_BYTES) throw new Error(`This body is larger than ${MEDIA_PREVIEW_MAX_BYTES / 1024 / 1024} MB, so it is not previewed. Save it to a file instead.`);
  return body.toString('base64');
}
