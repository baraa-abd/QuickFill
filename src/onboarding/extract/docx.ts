// .docx → plain text. Uses mammoth.js, which needs DOMParser — that's why
// extraction lives in the onboarding page (a regular extension page) and not
// in the SW. Per spec §9 step 5: "only the extracted text crosses the
// parse-resume RPC boundary."

import mammoth from 'mammoth';

export async function docxToText(file: File | Blob): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value ?? '';
}
