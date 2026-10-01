import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Private object storage. Objects are only ever reachable through short-lived presigned URLs. */
export interface StorageAdapter {
  presignPut(key: string, contentType: string, maxBytes: number): Promise<{ url: string; headers: Record<string, string>; expiresIn: number }>;
  presignGet(key: string, expiresIn?: number): Promise<string>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly s3: S3Client;
  constructor(
    private readonly bucket: string,
    region: string,
    endpoint?: string,
  ) {
    this.s3 = new S3Client({ region, endpoint, forcePathStyle: Boolean(endpoint) });
  }
  async presignPut(key: string, contentType: string, maxBytes: number) {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: maxBytes, ServerSideEncryption: 'AES256' });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: 300 });
    return { url, headers: { 'content-type': contentType }, expiresIn: 300 };
  }
  presignGet(key: string, expiresIn = 300) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async get(key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async exists(key: string) {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

/** Local filesystem storage for development and tests. */
export class LocalStorageAdapter implements StorageAdapter {
  private readonly root: string;
  constructor(dir: string, private readonly baseUrl: string) {
    this.root = resolve(dir);
  }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error('Invalid key');
    return p;
  }
  async presignPut(key: string, contentType: string) {
    return { url: `${this.baseUrl}/__local-storage/${encodeURIComponent(key)}`, headers: { 'content-type': contentType }, expiresIn: 300 };
  }
  async presignGet(key: string) {
    return `${this.baseUrl}/__local-storage/${encodeURIComponent(key)}?sig=dev`;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  get(key: string) {
    return readFile(this.path(key));
  }
  async exists(key: string) {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
}
