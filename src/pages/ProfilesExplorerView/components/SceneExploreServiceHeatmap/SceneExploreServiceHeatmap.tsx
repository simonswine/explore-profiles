import { css } from '@emotion/css';
import { GrafanaTheme2, MutableDataFrame } from '@grafana/data';
import { getProfileMetric } from '@shared/infrastructure/profile-metrics/getProfileMetric';
import {
  SceneComponentProps,
  SceneFlexItem,
  SceneFlexLayout,
  sceneGraph,
  SceneObjectBase,
  SceneObjectState,
} from '@grafana/scenes';
import { Drawer, useStyles2 } from '@grafana/ui';
import { quoteLabelName } from '@shared/components/QueryBuilder/domain/helpers/quoteLabelName';
import React from 'react';

import { FiltersVariable } from '../../domain/variables/FiltersVariable/FiltersVariable';
import { ProfileMetricVariable } from '../../domain/variables/ProfileMetricVariable';
import { ServiceNameVariable } from '../../domain/variables/ServiceNameVariable/ServiceNameVariable';
import { GridItemData } from '../SceneByVariableRepeaterGrid/types/GridItemData';
import {
  buildExemplarDataFrame,
  buildHeatmapDataFrame,
  ExemplarRow,
  extractExemplarRows,
} from './infrastructure/buildHeatmapDataFrames';
import { ExemplarType, HeatmapApiClient, HeatmapQueryType } from './infrastructure/HeatmapApiClient';
import { SceneExemplarTable } from './SceneExemplarTable';
import { SceneHeatmap } from './SceneHeatmap';
import { SceneTracePanel } from './SceneTracePanel';

interface SceneExploreServiceHeatmapState extends SceneObjectState {
  body: SceneFlexLayout;
  tracePanel: SceneTracePanel;
  isLoading: boolean;
  heatmapFrame?: MutableDataFrame;
  exemplarFrame?: MutableDataFrame;
  exemplarRows: ExemplarRow[];
  selectedSpanId?: string;
  selectedTraceId?: string;
  tempoDataSourceUid?: string;
}

export class SceneExploreServiceHeatmap extends SceneObjectBase<SceneExploreServiceHeatmapState> {
  constructor({ item }: { item?: GridItemData }) {
    super({
      key: 'explore-service-heatmap',
      isLoading: false,
      heatmapFrame: undefined,
      exemplarFrame: undefined,
      exemplarRows: [],
      selectedSpanId: undefined,
      selectedTraceId: undefined,
      tempoDataSourceUid: undefined,
      tracePanel: new SceneTracePanel(),
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({ minHeight: '400px', body: new SceneHeatmap() }),
          new SceneFlexItem({ minHeight: '300px', body: new SceneExemplarTable() }),
        ],
      }),
    });

    this.addActivationHandler(this.onActivate.bind(this, item));
  }

  onActivate(item?: GridItemData) {
    if (item) {
      this.initVariables(item);
    }

    const profileMetricVariable = sceneGraph.findByKeyAndType(this, 'profileMetricId', ProfileMetricVariable);
    profileMetricVariable.setState({ query: ProfileMetricVariable.QUERY_SERVICE_NAME_DEPENDENT });
    profileMetricVariable.update(true);

    const timeRangeSub = sceneGraph.getTimeRange(this).subscribeToState(() => {
      this.fetchHeatmapData();
    });

    const serviceNameSub = sceneGraph
      .findByKeyAndType(this, 'serviceName', ServiceNameVariable)
      .subscribeToState((newState, prevState) => {
        if (newState.value !== prevState.value) {
          this.fetchHeatmapData();
        }
      });

    const profileMetricSub = profileMetricVariable.subscribeToState((newState, prevState) => {
      if (newState.value !== prevState.value) {
        this.fetchHeatmapData();
      }
    });

    const filtersSub = sceneGraph
      .findByKeyAndType(this, 'filters', FiltersVariable)
      .subscribeToState((newState, prevState) => {
        if (JSON.stringify(newState.filters) !== JSON.stringify(prevState.filters)) {
          this.fetchHeatmapData();
        }
      });

    this.fetchHeatmapData();

    return () => {
      timeRangeSub.unsubscribe();
      serviceNameSub.unsubscribe();
      profileMetricSub.unsubscribe();
      filtersSub.unsubscribe();
      profileMetricVariable.setState({ query: ProfileMetricVariable.QUERY_DEFAULT });
      profileMetricVariable.update(true);
    };
  }

  initVariables(item: GridItemData) {
    const { serviceName, profileMetricId, filters } = item.queryRunnerParams;

    if (serviceName) {
      sceneGraph.findByKeyAndType(this, 'serviceName', ServiceNameVariable).changeValueTo(serviceName);
    }

    if (profileMetricId) {
      sceneGraph.findByKeyAndType(this, 'profileMetricId', ProfileMetricVariable).changeValueTo(profileMetricId);
    }

    if (filters) {
      sceneGraph.findByKeyAndType(this, 'filters', FiltersVariable).setState({ filters });
    }
  }

  async fetchHeatmapData() {
    const dataSourceUid = sceneGraph.interpolate(this, '$dataSource');
    const serviceName = sceneGraph.interpolate(this, '$serviceName');
    const profileTypeId = sceneGraph.interpolate(this, '$profileMetricId');

    if (!dataSourceUid || !serviceName || !profileTypeId) {
      return;
    }

    const filtersVar = sceneGraph.findByKeyAndType(this, 'filters', FiltersVariable);
    const filters = filtersVar.state.filters ?? [];

    const completeFilters = [{ key: 'service_name', operator: '=', value: serviceName }, ...filters];
    const labelSelector = `{${completeFilters.map(({ key, operator, value }) => `${quoteLabelName(key)}${operator}"${value}"`).join(',')}}`;

    const timeRange = sceneGraph.getTimeRange(this).state.value;
    const start = timeRange.from.valueOf();
    const end = timeRange.to.valueOf();
    const durationSec = (end - start) / 1000;
    const step = Math.max(1, Math.ceil(durationSec / 64));

    this.setState({ isLoading: true });

    try {
      const client = new HeatmapApiClient({ dataSourceUid });
      const response = await client.selectHeatmap({
        profileTypeID: profileTypeId,
        labelSelector,
        start,
        end,
        step,
        groupBy: [],
        queryType: HeatmapQueryType.SPAN,
        exemplarType: ExemplarType.SPAN,
      });

      const { unit } = getProfileMetric(profileTypeId as any);

      const series = response.series?.[0];
      const heatmapFrame = series ? buildHeatmapDataFrame(series, unit) ?? undefined : undefined;
      const exemplarFrame = buildExemplarDataFrame(response, unit) ?? undefined;
      const exemplarRows = extractExemplarRows(response);

      this.setState({ isLoading: false, heatmapFrame, exemplarFrame, exemplarRows });
    } catch {
      this.setState({ isLoading: false });
    }
  }

  getVariablesAndGridControls() {
    return {
      variables: [
        sceneGraph.findByKeyAndType(this, 'serviceName', ServiceNameVariable),
        sceneGraph.findByKeyAndType(this, 'profileMetricId', ProfileMetricVariable),
        sceneGraph.findByKeyAndType(this, 'filters', FiltersVariable),
      ],
      gridControls: [],
    };
  }

  static Component({ model }: SceneComponentProps<SceneExploreServiceHeatmap>) {
    const styles = useStyles2(getStyles);
    const { body, tracePanel, selectedTraceId } = model.useState();

    return (
      <div className={styles.flex}>
        <body.Component model={body} />
        {selectedTraceId && tracePanel && (
          <Drawer
            title={`Trace ${selectedTraceId}`}
            size="lg"
            scrollableContent={false}
            onClose={() => model.setState({ selectedTraceId: undefined, selectedSpanId: undefined })}
          >
            <tracePanel.Component model={tracePanel} />
          </Drawer>
        )}
      </div>
    );
  }
}

const getStyles = (theme: GrafanaTheme2) => ({
  flex: css`
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    gap: ${theme.spacing(1)};
  `,
});
