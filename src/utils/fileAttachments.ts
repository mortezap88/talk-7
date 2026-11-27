import type { ChatAttachment } from '../types/talk';
import { createId } from './formatters';

export interface ProcessedFilesResult {
  images: ChatAttachment[];
  textBlocks: string[];
}

export async function processSelectedFiles(
  files: FileList | File[]
): Promise<ProcessedFilesResult> {
  const images: ChatAttachment[] = [];
  const textBlocks: string[] = [];

  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
      if (dataUrl) {
        images.push({
          id: createId('att'),
          kind: 'image',
          name: file.name || 'pasted-image.png',
          mimeType: file.type,
          dataUrl,
        });
      }
    } else if (
      file.type.startsWith('text/') ||
      /\.(txt|md|csv|json|ts|tsx|js|jsx|py|html|css)$/i.test(file.name)
    ) {
      const text = await file.text();
      textBlocks.push(`[${file.name}]\n${text.trim()}`);
    }
  }

  return { images, textBlocks };
}
