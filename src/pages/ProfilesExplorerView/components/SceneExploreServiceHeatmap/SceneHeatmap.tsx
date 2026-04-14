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
import React from 'react';

import { SceneExploreServiceHeatmap } from './SceneExploreServiceHeatmap';

interface SceneHeatmapState extends SceneObjectState {
  body: VizPanel;
}

export class SceneHeatmap extends SceneObjectBase<SceneHeatmapState> {
  constructor() {
    super({
      key: 'scene-heatmap',
      body: SceneHeatmap.buildPanel(),
    });

    this.addActivationHandler(this.onActivate.bind(this));
  }

  private static buildPanel(): VizPanel {
    return PanelBuilders.heatmap()
      .setTitle('Span Profile Heatmap')
      .setOption('calculate', false)
      .setOption('cellGap', 1)
      .setOption('color', {
        scheme: 'Spectral',
        steps: 64,
      })
      .setOption('tooltip', {
        mode: TooltipDisplayMode.Single,
        yHistogram: true,
        showColorScale: true,
      })
      .setOption('exemplars', { color: 'rgba(31, 120, 193, 0.7)' })
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

    if (exemplarFrame) {
      const idField = exemplarFrame.fields.find((f) => f.name === 'Id');
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
    }

    (this.state.body.state.$data as SceneDataNode).setState({
      data: {
        state: isLoading ? LoadingState.Loading : LoadingState.Done,
        series: frame ? [frame] : [],
        annotations: exemplarFrame ? [exemplarFrame] : [],
        timeRange,
      },
    });
  }

  static Component({ model }: SceneComponentProps<SceneHeatmap>) {
    const { body } = model.useState();
    return <body.Component model={body} />;
  }
}
