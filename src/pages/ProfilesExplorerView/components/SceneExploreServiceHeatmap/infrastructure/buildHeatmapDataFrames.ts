import { DataFrameType, DataTopic, FieldType, MutableDataFrame } from '@grafana/data';
import { SelectHeatmapResponse } from '@shared/pyroscope-api/querier/v1/querier_pb';
import { HeatmapSeries } from '@shared/pyroscope-api/types/v1/types_pb';

export interface ExemplarRow {
  profileId: string;
  timestamp: number;
  value: number;
  spanId?: string;
  spanName?: string;
}

/**
 * Builds a sparse "heatmap-cells" DataFrame from a HeatmapSeries, matching the format
 * produced by the Grafana backend in heatmap/heatmap.go (PR #120995).
 *
 * Only non-zero cells are emitted. A gap-filling calibration row is inserted after the
 * first slot when consecutive timestamps are more than one step apart, so the frontend
 * panel can infer the correct bucket width.
 *
 * Fields: xMax (Time), yMin (Number, unit), yMax (Number, unit), count (Number).
 * frame.meta.type = DataFrameType.HeatmapCells
 */
export function buildHeatmapDataFrame(series: HeatmapSeries, unit: string, stepMs: number): MutableDataFrame | null {
  const slots = series?.slots;
  if (!slots?.length) {
    return null;
  }

  const sortedSlots = [...slots].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

  const xMaxValues: number[] = [];
  const yMinValues: number[] = [];
  const yMaxValues: number[] = [];
  const countValues: number[] = [];

  for (let i = 0; i < sortedSlots.length; i++) {
    const slot = sortedSlots[i];
    const xMax = Number(slot.timestamp);
    const { yMin, counts } = slot;

    for (let j = 0; j < counts.length; j++) {
      if (counts[j] === 0) {
        continue;
      }

      let yMax: number;
      if (j < yMin.length - 1) {
        yMax = yMin[j + 1];
      } else if (j > 0) {
        yMax = yMin[j] + (yMin[j] - yMin[j - 1]);
      } else {
        yMax = yMin[j] * 2;
      }

      xMaxValues.push(xMax);
      yMinValues.push(yMin[j]);
      yMaxValues.push(yMax);
      countValues.push(counts[j]);
    }

    // Gap-filling calibration: if the gap to the next slot is > stepMs, insert a
    // zero-count row at timestamp+stepMs so the panel infers the correct bucket width.
    if (i === 0 && sortedSlots.length > 1 && Number(sortedSlots[1].timestamp) !== xMax + stepMs) {
      const calYMin = yMin.length > 0 ? yMin[0] : 0;
      const calYMax = yMin.length > 1 ? yMin[1] : calYMin * 2;
      xMaxValues.push(xMax + stepMs);
      yMinValues.push(calYMin);
      yMaxValues.push(calYMax);
      countValues.push(0);
    }
  }

  if (xMaxValues.length === 0) {
    return null;
  }

  const frame = new MutableDataFrame({
    name: 'heatmap',
    meta: { type: DataFrameType.HeatmapCells },
    fields: [
      { name: 'xMax', type: FieldType.time, values: xMaxValues, config: {} },
      { name: 'yMin', type: FieldType.number, values: yMinValues, config: { unit } },
      { name: 'yMax', type: FieldType.number, values: yMaxValues, config: { unit } },
      { name: 'count', type: FieldType.number, values: countValues, config: {} },
    ],
  });

  return frame;
}

interface CollectedExemplar {
  timestamp: number;
  value: number;
  id: string;
  labels: Record<string, string>;
}

/**
 * Builds an annotation DataFrame for heatmap exemplar markers, matching the format
 * produced by exemplar/exemplar.go (PR #120995).
 *
 * Includes all label fields (series labels merged with per-exemplar labels) so the
 * heatmap tooltip shows the same context as the exemplar popover in the timeseries view.
 *
 * The heatmap panel picks up frames with `meta.dataTopic === 'annotations'` and
 * `frame.name === 'exemplar'` to render as diamond markers.
 */
export function buildExemplarDataFrame(
  response: SelectHeatmapResponse,
  unit: string
): MutableDataFrame | null {
  const collected: CollectedExemplar[] = [];

  for (const series of response.series ?? []) {
    const seriesLabels: Record<string, string> = {};
    for (const label of series.labels ?? []) {
      seriesLabels[label.name] = label.value;
    }

    for (const slot of series.slots ?? []) {
      for (const exemplar of slot.exemplars ?? []) {
        const labels: Record<string, string> = { ...seriesLabels };
        for (const label of exemplar.labels ?? []) {
          labels[label.name] = label.value;
        }
        collected.push({
          timestamp: Number(exemplar.timestamp),
          value: Number(exemplar.value),
          id: exemplar.spanId || exemplar.profileId,
          labels,
        });
      }
    }
  }

  if (collected.length === 0) {
    return null;
  }

  // Collect all unique label names across all exemplars (sorted for consistency)
  const uniqLabelNames = new Set<string>();
  for (const e of collected) {
    for (const name of Object.keys(e.labels)) {
      uniqLabelNames.add(name);
    }
  }
  const sortedLabelNames = [...uniqLabelNames].sort();

  return new MutableDataFrame({
    name: 'exemplar',
    meta: { dataTopic: DataTopic.Annotations as any },
    fields: [
      { name: 'Time', type: FieldType.time, values: collected.map((e) => e.timestamp), config: {} },
      { name: 'Value', type: FieldType.number, values: collected.map((e) => e.value), config: { unit } },
      {
        name: 'Id',
        type: FieldType.string,
        values: collected.map((e) => e.id),
        config: { displayName: 'Span ID' },
      },
      ...sortedLabelNames.map((name) => ({
        name,
        type: FieldType.string,
        values: collected.map((e) => e.labels[name] ?? ''),
        config: {},
      })),
    ],
  });
}

/**
 * Collects all exemplars from a SelectHeatmap response, deduplicates by spanId,
 * sorts by value descending, and returns the top 50 rows for the exemplar table.
 */
export function extractExemplarRows(response: SelectHeatmapResponse): ExemplarRow[] {
  const seen = new Set<string>();
  const rows: ExemplarRow[] = [];

  for (const series of response.series ?? []) {
    for (const slot of series.slots ?? []) {
      for (const exemplar of slot.exemplars ?? []) {
        const key = exemplar.spanId || exemplar.profileId;
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        const labels: Record<string, string> = {};
        for (const label of series.labels ?? []) {
          labels[label.name] = label.value;
        }
        for (const label of exemplar.labels ?? []) {
          labels[label.name] = label.value;
        }
        rows.push({
          profileId: exemplar.profileId,
          timestamp: Number(exemplar.timestamp),
          value: Number(exemplar.value),
          spanId: exemplar.spanId || undefined,
          spanName: labels['span_name'] || labels['span.name'] || undefined,
        });
      }
    }
  }

  rows.sort((a, b) => b.value - a.value);
  return rows.slice(0, 50);
}
