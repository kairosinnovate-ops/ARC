import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface Storage {
  uploadUrl(key: string, contentType: string): Promise<string>;
  downloadUrl(key: string, filename: string): Promise<string>;
  size(key: string): Promise<number | null>;
}

let storage: Storage | null = null;

/** Lets the local dev server use a folder on disk instead of the bucket. */
export function setStorage(s: Storage) {
  storage = s;
}

function s3Storage(): Storage {
  const client = new S3Client({
    region: process.env.STORAGE_REGION || 'us-east-2',
    endpoint: process.env.STORAGE_ENDPOINT,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || '',
    },
    forcePathStyle: true,
    // Presigned PUTs must not carry a checksum of an empty body.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  const Bucket = process.env.STORAGE_BUCKET || 'arc-files';
  return {
    uploadUrl: (Key, ContentType) =>
      getSignedUrl(client, new PutObjectCommand({ Bucket, Key, ContentType }), { expiresIn: 900 }),
    downloadUrl: (Key, filename) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket,
          Key,
          ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`,
        }),
        { expiresIn: 300 },
      ),
    size: async (Key) => {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
        return head.ContentLength ?? null;
      } catch {
        return null;
      }
    },
  };
}

export function files(): Storage {
  if (!storage) storage = s3Storage();
  return storage;
}
