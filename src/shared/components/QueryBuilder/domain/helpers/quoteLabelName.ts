const SAFE_LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Returns the label name quoted in double-quotes if it contains characters
 * outside [a-zA-Z_][a-zA-Z0-9_]*, as required by the Pyroscope/PromQL UTF-8
 * label matcher syntax. Safe names are returned unchanged.
 */
export function quoteLabelName(name: string): string {
  return SAFE_LABEL_NAME_RE.test(name) ? name : `"${name}"`;
}
