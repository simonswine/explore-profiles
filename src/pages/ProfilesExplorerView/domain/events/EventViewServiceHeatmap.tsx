import { BusEventWithPayload } from '@grafana/data';

import { GridItemData } from '../../components/SceneByVariableRepeaterGrid/types/GridItemData';

export interface EventViewServiceHeatmapPayload {
  item: GridItemData;
}

export class EventViewServiceHeatmap extends BusEventWithPayload<EventViewServiceHeatmapPayload> {
  public static type = 'view-service-heatmap';
}
