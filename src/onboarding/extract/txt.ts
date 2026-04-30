// UTF-8 plain-text decoding. Trivial wrapper for symmetry with `docx.ts`.

export async function txtToText(file: File | Blob): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
}
