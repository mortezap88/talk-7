import type { ChatAttachment } from '../types/talk';

const DEFAULT_MAX_DATA_URL_CHARS = 480_000;

export async function compressDataUrlForFirestore(
  dataUrl: string,
  mimeType: string,
  maxChars = DEFAULT_MAX_DATA_URL_CHARS
): Promise<{ dataUrl: string; mimeType: string }> {
  if (!dataUrl || dataUrl.length <= maxChars) {
    return { dataUrl, mimeType };
  }
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return { dataUrl, mimeType };
  }

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode image for Firestore storage.'));
      el.src = dataUrl;
    });

    let maxEdge = 1600;
    let quality = 0.85;
    let candidate = dataUrl;
    const outMime = 'image/jpeg';

    for (let attempt = 0; attempt < 5; attempt++) {
      const longest = Math.max(img.naturalWidth, img.naturalHeight, 1);
      const scale = Math.min(1, maxEdge / longest);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) break;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      candidate = canvas.toDataURL(outMime, quality);
      if (candidate.length <= maxChars) {
        return { dataUrl: candidate, mimeType: outMime };
      }

      maxEdge = Math.round(maxEdge * 0.75);
      quality = Math.max(0.5, quality - 0.12);
    }

    return { dataUrl: candidate, mimeType: outMime };
  } catch {
    return { dataUrl, mimeType };
  }
}

export async function compressAttachmentForFirestore(
  attachment: ChatAttachment,
  maxChars = DEFAULT_MAX_DATA_URL_CHARS
): Promise<ChatAttachment> {
  if (attachment.kind !== 'image' || !attachment.dataUrl || attachment.dataUrl.length <= maxChars) {
    return attachment;
  }
  const compressed = await compressDataUrlForFirestore(
    attachment.dataUrl,
    attachment.mimeType,
    maxChars
  );
  return {
    ...attachment,
    dataUrl: compressed.dataUrl,
    mimeType: compressed.mimeType,
  };
}
