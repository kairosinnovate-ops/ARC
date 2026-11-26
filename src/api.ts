import { auth } from './auth';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let firmId = '';
export function setFirm(id: string) {
  firmId = id;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await auth.token();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (firmId) headers['x-arc-firm'] = firmId;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch('/api' + path, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.error || `Request failed (${r.status})`);
  return data as T;
}

export async function sha256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hash, register, upload straight to storage, then confirm. */
export async function uploadFile(
  setId: string,
  file: File,
  meta: { kind: string; sheet?: string },
  onProgress?: (pct: number) => void,
) {
  const hash = await sha256(file);
  const start = await api<{ file_id: string; upload_url: string; content_type: string }>(`/sets/${setId}/files`, {
    body: {
      kind: meta.kind,
      sheet: meta.sheet || '',
      filename: file.name,
      size: file.size,
      sha256: hash,
      content_type: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
    },
  });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', start.upload_url);
    xhr.setRequestHeader('content-type', start.content_type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.send(file);
  });
  await api(`/files/${start.file_id}/complete`, { body: {} });
  return hash;
}

export async function download(fileId: string) {
  const { url } = await api<{ url: string }>(`/files/${fileId}/download`);
  window.location.href = url;
}
