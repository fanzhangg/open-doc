// Reading and writing the sidecar JSON (SPEC.md §2, §7).

import { FORMAT_VERSION } from './ops.js';

export class FormatError extends Error {
  /** @param {'invalid' | 'version' | 'doc_mismatch'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Parse sidecar text, refusing unknown major versions and foreign docs. */
export function parseSidecar(json, docName) {
  let data;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new FormatError('invalid', `sidecar is not valid JSON: ${error.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new FormatError('invalid', 'sidecar is not a JSON object');
  }
  if (data.opendoc !== FORMAT_VERSION) {
    throw new FormatError('version', `unsupported opendoc version ${data.opendoc}; this tool reads version ${FORMAT_VERSION}`);
  }
  if (docName !== undefined && data.doc !== docName) {
    throw new FormatError('doc_mismatch', `sidecar belongs to "${data.doc}", not "${docName}" (was the doc copied or renamed?)`);
  }
  if (!Array.isArray(data.threads) || !Array.isArray(data.participants)) {
    throw new FormatError('invalid', 'sidecar is missing threads or participants');
  }
  return data;
}

export function serializeSidecar(sidecar) {
  return JSON.stringify(sidecar, null, 2) + '\n';
}
