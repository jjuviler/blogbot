import { postJSON } from '../utils/net.js';

export async function runStyleCheck({ text, html, debug = false, designOnly = false } = {}, { signal } = {}) {
  const body = {};
  if (html && html.trim()) body.html = html;
  else if (text && text.trim()) body.text = text;
  if (debug) body.debug = true;
  if (designOnly) body.designOnly = true;
  const res = await postJSON('/api/stylecheck', body, { signal });
  return res;
}


