import { postJSON } from '../utils/net.js';

export async function runLegalReview(text, { signal } = {}) {
  const res = await postJSON('/legal-review', { text }, { signal });
  return res;
}


