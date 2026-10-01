export interface QualityResult {
  ok: boolean;
  reason?: string;
}

/** OCR + image quality. Production should plug in a managed OCR service (data must stay in India). */
export interface OcrAdapter {
  checkQuality(image: Buffer, contentType: string): Promise<QualityResult>;
  extractText(image: Buffer, contentType: string): Promise<string>;
}

export class BasicOcrAdapter implements OcrAdapter {
  async checkQuality(image: Buffer, contentType: string): Promise<QualityResult> {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(contentType)) return { ok: false, reason: 'unsupported_format' };
    if (image.length < 20 * 1024) return { ok: false, reason: 'too_small_or_blurry' };
    return { ok: true };
  }
  async extractText(): Promise<string> {
    return ''; // no OCR engine configured; pharmacist transcription is the source of truth
  }
}
