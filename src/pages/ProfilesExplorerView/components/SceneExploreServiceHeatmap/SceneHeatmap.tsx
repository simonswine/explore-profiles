import { css } from '@emotion/css';
import { DataLinkClickEvent, LoadingState, MutableDataFrame } from '@grafana/data';
import {
  PanelBuilders,
  SceneComponentProps,
  SceneDataNode,
  sceneGraph,
  SceneObjectBase,
  SceneObjectState,
  VizPanel,
} from '@grafana/scenes';
import { TooltipDisplayMode } from '@grafana/schema';
import { useStyles2 } from '@grafana/ui';
import React, { useCallback, useEffect, useRef } from 'react';

import { SceneExploreServiceHeatmap } from './SceneExploreServiceHeatmap';

interface SelectedExemplar {
  timestamp: number; // ms
  value: number;
}

interface SceneHeatmapState extends SceneObjectState {
  body: VizPanel;
  selectedExemplar?: SelectedExemplar;
  yMin: number;
  yMax: number;
}

const EXEMPLAR_COLOR_DEFAULT = 'rgba(31, 120, 193, 0.7)';
const EXEMPLAR_HIGHLIGHT_COLOR = 'rgba(255, 152, 0, 1)';
const MARKER_SIZE = 8; // px — matches the heatmap panel's exemplar diamond size

export class SceneHeatmap extends SceneObjectBase<SceneHeatmapState> {
  constructor() {
    super({
      key: 'scene-heatmap',
      body: SceneHeatmap.buildPanel(),
      selectedExemplar: undefined,
      yMin: 0,
      yMax: 1,
    });

    this.addActivationHandler(this.onActivate.bind(this));
  }

  private static buildPanel(): VizPanel {
    return PanelBuilders.heatmap()
      .setTitle('Span Profile Heatmap')
      .setOption('calculate', false)
      .setOption('cellGap', 1)
      .setOption('color', { scheme: 'Spectral', steps: 64 })
      .setOption('tooltip', { mode: TooltipDisplayMode.Single, yHistogram: true, showColorScale: true })
      .setOption('exemplars', { color: EXEMPLAR_COLOR_DEFAULT })
      .setData(new SceneDataNode())
      .build();
  }

  onActivate() {
    let parent: SceneExploreServiceHeatmap | undefined;
    try {
      parent = sceneGraph.getAncestor(this, SceneExploreServiceHeatmap);
    } catch {
      return;
    }

    const parentSub = parent.subscribeToState((newState, prevState) => {
      if (
        newState.heatmapFrame !== prevState.heatmapFrame ||
        newState.exemplarFrame !== prevState.exemplarFrame ||
        newState.isLoading !== prevState.isLoading ||
        newState.selectedSpanId !== prevState.selectedSpanId
      ) {
        this.updateData(
          newState.heatmapFrame,
          newState.exemplarFrame,
          newState.isLoading,
          newState.selectedSpanId,
          parent!
        );
      }
    });

    return () => parentSub.unsubscribe();
  }

  private updateData(
    frame: MutableDataFrame | undefined,
    exemplarFrame: MutableDataFrame | undefined,
    isLoading: boolean,
    selectedSpanId: string | undefined,
    parent: SceneExploreServiceHeatmap
  ) {
    const timeRange = sceneGraph.getTimeRange(this).state.value;
    const annotations: MutableDataFrame[] = [];
    let selectedExemplar: SelectedExemplar | undefined;

    // Compute y extent from the heatmap frame for overlay positioning
    let yMin = 0;
    let yMax = 1;
    if (frame) {
      const yMinField = frame.fields.find((f) => f.name === 'yMin');
      if (yMinField) {
        const vals: number[] = yMinField.values.toArray();
        yMin = Math.min(...vals);
        const yBucketSize: number = (frame.meta?.custom as any)?.yBucketSize ?? 0;
        yMax = Math.max(...vals) + yBucketSize;
      }
    }

    if (exemplarFrame) {
      const idField = exemplarFrame.fields.find((f) => f.name === 'Id');
      const timeField = exemplarFrame.fields.find((f) => f.name === 'Time');
      const valueField = exemplarFrame.fields.find((f) => f.name === 'Value');

      if (idField) {
        idField.config = {
          ...idField.config,
          links: [
            {
              title: 'Select exemplar',
              url: '',
              onClick: (event: DataLinkClickEvent) => {
                const spanId = event.replaceVariables?.('${__value.raw}');
                if (spanId) {
                  parent.setState({
                    selectedSpanId: spanId === parent.state.selectedSpanId ? undefined : spanId,
                  });
                }
              },
            },
          ],
        };
      }

      if (selectedSpanId && idField && timeField && valueField) {
        const idx = idField.values.toArray().indexOf(selectedSpanId);
        if (idx >= 0) {
          selectedExemplar = {
            timestamp: timeField.values.get(idx),
            value: valueField.values.get(idx),
          };
        }
      }

      annotations.push(exemplarFrame);
    }

    this.setState({ selectedExemplar, yMin, yMax });

    (this.state.body.state.$data as SceneDataNode).setState({
      data: {
        state: isLoading ? LoadingState.Loading : LoadingState.Done,
        series: frame ? [frame] : [],
        annotations,
        timeRange,
      },
    });
  }

  static Component({ model }: SceneComponentProps<SceneHeatmap>) {
    const { body, selectedExemplar, yMin, yMax } = model.useState();
    const timeRange = sceneGraph.getTimeRange(model).useState().value;
    const styles = useStyles2(getStyles);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);

    const drawOverlay = useCallback(() => {
      const overlay = overlayRef.current;
      const wrapper = wrapperRef.current;
      if (!overlay || !wrapper) {
        return;
      }

      const ctx = overlay.getContext('2d');
      if (!ctx) {
        return;
      }

      // The canvas is the only canvas in our wrapper (the heatmap panel renders
      // directly without a .uplot wrapper div in this Scenes context).
      const panelCanvas = wrapper.querySelector<HTMLCanvasElement>('canvas');
      if (!panelCanvas) {
        return;
      }

      // Size the overlay to exactly cover the panel canvas
      const rect = panelCanvas.getBoundingClientRect();
      const wrapRect = wrapper.getBoundingClientRect();
      overlay.style.left = `${rect.left - wrapRect.left}px`;
      overlay.style.top = `${rect.top - wrapRect.top}px`;
      overlay.width = panelCanvas.width;
      overlay.height = panelCanvas.height;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;

      ctx.clearRect(0, 0, overlay.width, overlay.height);

      if (!selectedExemplar) {
        return;
      }

      // Compute pixel position using the time range (x) and frame y extent.
      // We get xMin/xMax from the Scenes time range and yMin/yMax from the
      // heatmap frame stored in parent state. The heatmap panel uses a linear
      // scale for both axes (we confirmed the data is linearly spaced).
      const dpr = window.devicePixelRatio || 1;
      const xMin = timeRange.from.valueOf();
      const xMax = timeRange.to.valueOf();

      // Read the actual plot area from the .u-over div (the uPlot cursor overlay
      // which covers exactly the data area, excluding axis margins).
      const canvasRect = panelCanvas.getBoundingClientRect();
      const uOver = wrapper.querySelector('.u-over');
      let plotLeft: number, plotTop: number, plotW: number, plotH: number;

      if (uOver) {
        const overRect = uOver.getBoundingClientRect();
        // Convert from page coords to canvas pixel coords (accounting for dpr)
        const scaleX = panelCanvas.width / canvasRect.width;
        const scaleY = panelCanvas.height / canvasRect.height;
        plotLeft = (overRect.left - canvasRect.left) * scaleX;
        plotTop = (overRect.top - canvasRect.top) * scaleY;
        plotW = overRect.width * scaleX;
        plotH = overRect.height * scaleY;
      } else {
        // Fallback: hardcoded estimates
        plotLeft = 55 * dpr;
        plotTop = 10 * dpr;
        plotW = panelCanvas.width - plotLeft;
        plotH = panelCanvas.height - 30 * dpr - plotTop;
      }

      const xFrac = (selectedExemplar.timestamp - xMin) / (xMax - xMin);
      const yFrac = (selectedExemplar.value - yMin) / (yMax - yMin);
      const xPx = plotLeft + xFrac * plotW;
      // The bottom tip of the diamond was at the right position, so shift up by size to centre it
      const yPx = plotTop + (1 - yFrac) * plotH + MARKER_SIZE * dpr;

      if (isNaN(xPx) || isNaN(yPx)) {
        return;
      }

      const size = MARKER_SIZE * dpr;

      ctx.save();
      ctx.strokeStyle = EXEMPLAR_HIGHLIGHT_COLOR;
      ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = EXEMPLAR_HIGHLIGHT_COLOR;
      ctx.shadowBlur = 4 * dpr;

      // Draw a diamond outline matching the exemplar marker shape
      ctx.beginPath();
      ctx.moveTo(xPx, yPx - size);
      ctx.lineTo(xPx + size, yPx);
      ctx.lineTo(xPx, yPx + size);
      ctx.lineTo(xPx - size, yPx);
      ctx.closePath();
      ctx.stroke();

      ctx.restore();
    }, [selectedExemplar, yMin, yMax, timeRange]);

    useEffect(() => {
      drawOverlay();

      // Redraw on resize
      const ro = new ResizeObserver(drawOverlay);
      if (wrapperRef.current) {
        ro.observe(wrapperRef.current);
      }
      return () => ro.disconnect();
    }, [drawOverlay]);

    return (
      <div ref={wrapperRef} className={styles.wrapper}>
        <body.Component model={body} />
        <canvas ref={overlayRef} className={styles.overlay} />
      </div>
    );
  }
}

const getStyles = () => ({
  wrapper: css`
    position: relative;
    width: 100%;
    height: 100%;
  `,
  overlay: css`
    position: absolute;
    pointer-events: none;
  `,
});
