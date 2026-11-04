export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_TEXT = 200000;

export function words(text) {
  const result = [];
  let previous = 0, offset = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)) {
    offset += Array.from(text.slice(previous, match.index)).length;
    const end = offset + Array.from(match[0]).length;
    result.push({id:result.length, text:match[0], start:offset, end});
    previous = match.index + match[0].length;
    offset = end;
  }
  return result;
}

class ImportError extends Error {}

export function importText(text) {
  if (typeof text !== 'string') throw new ImportError('Paste text or choose a TXT or DOCX file.');
  if (Array.from(text).length > MAX_TEXT) throw new ImportError('Text is too long. Import at most 200,000 characters at a time.');
  text = text.replace(/\r\n?/g, '\n').normalize('NFC').replace(/\u00ad/g, '').replace(/^[\ufeff \t\n]+|[\ufeff \t\n]+$/g, '');
  if (!text.trim()) throw new ImportError('There is no readable text. Paste some Danish text or choose another file.');
  if (text.includes('\0')) throw new ImportError('This does not look like a text document. Save it as UTF-8 TXT and try again.');
  const paragraphs = text.split(/\n[\t ]*\n+/).filter(part => part.trim()).map((part, id) => ({id, text:part, words:words(part)}));
  return {text, paragraphs, warnings:[]};
}

function checkDocxSize(buffer) {
  const view = new DataView(buffer), length = buffer.byteLength;
  const invalid = () => { throw new ImportError('Could not read this DOCX. It may be damaged or use an unsupported ZIP format. Save it as TXT.'); };
  let end = -1;
  for (let i = length - 22; i >= Math.max(0, length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === length) { end = i; break; }
  }
  if (end < 0) invalid();
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ImportError('ZIP64 DOCX files are unsupported. Save a smaller document as DOCX or TXT.');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || start + size !== end) invalid();
  let cursor = start, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) invalid();
    const unpacked = view.getUint32(cursor + 24, true);
    if (unpacked === 0xffffffff || view.getUint32(cursor + 20, true) === 0xffffffff || view.getUint32(cursor + 42, true) === 0xffffffff) throw new ImportError('ZIP64 DOCX files are unsupported. Save a smaller document as DOCX or TXT.');
    expanded += unpacked;
    if (expanded > 50 * 1024 * 1024) throw new ImportError('This DOCX expands beyond the safe extraction limit. Save a smaller document.');
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    if (cursor > end) invalid();
  }
  if (cursor !== end) invalid();
}

export async function extractFile(file) {
  if (!file || typeof file.name !== 'string' || !Number.isFinite(file.size) || file.size < 0) throw new ImportError('Choose a TXT or DOCX file.');
  if (file.size > MAX_FILE) throw new ImportError('File is too large. Choose a file no bigger than 10 MiB.');
  const suffix = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (suffix === '.doc') throw new ImportError('Older .doc files are not supported. Save the document as DOCX or TXT first.');
  if (!['.txt', '.docx'].includes(suffix)) throw new ImportError('Choose a TXT or DOCX file.');
  const warnings = [];
  let text;
  try {
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_FILE) throw new ImportError('File is too large. Choose a file no bigger than 10 MiB.');
    if (suffix === '.txt') {
      const bytes = new Uint8Array(buffer);
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      try { text = new TextDecoder(encoding, {fatal:true}).decode(bytes); }
      catch {
        text = new TextDecoder('windows-1252', {fatal:true}).decode(bytes);
        warnings.push('TXT was decoded as Windows-1252. Check the Danish characters in the preview.');
      }
    } else {
      checkDocxSize(buffer);
      if (!globalThis.mammoth) await import('./vendor/mammoth/mammoth.browser.min.js');
      const result = await globalThis.mammoth.extractRawText({arrayBuffer:buffer});
      text = result.value;
    }
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('Could not read this file. It may be damaged or use an unsupported format. Try saving it as TXT.');
  }
  const result = importText(text);
  result.warnings = warnings;
  return result;
}
