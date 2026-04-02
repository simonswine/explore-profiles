// Mirrors the Prometheus LegacyValidation rule for label names:
// https://github.com/prometheus/common/blob/0dfcdfb00df68e0b14a98f20d90f4b3ff12432e6/model/metric.go#L186-L195
const SAFE_LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Returns the label name quoted in double-quotes if it contains characters
 * outside [a-zA-Z_][a-zA-Z0-9_]*, as required by the Pyroscope/PromQL UTF-8
 * label matcher syntax. Safe names are returned unchanged.
 */
export function quoteLabelName(name: string): string {
  return SAFE_LABEL_NAME_RE.test(name) ? name : `"${name}"`;
}
