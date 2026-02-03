export type DashboardSpecV1 = {
  version: 1;
  name: string;
  sampleSize: number;
  bucketSeconds: number;
  widgets: WidgetSpec[];
};

export type WidgetLayout = { w: number; h: number };

export type WidgetSpec =
  | {
      id: string;
      type: 'stat';
      title: string;
      metric: 'events' | 'errors' | 'error_rate' | 'unique_traces' | 'unique_users';
      layout?: WidgetLayout;
    }
  | {
      id: string;
      type: 'bar';
      title: string;
      field: string;
      topN: number;
      layout?: WidgetLayout;
    }
  | {
      id: string;
      type: 'timeseries';
      title: string;
      metric: 'events' | 'errors' | 'error_rate';
      layout?: WidgetLayout;
    }
  | {
      id: string;
      type: 'histogram';
      title: string;
      field: string;
      bins: number;
      layout?: WidgetLayout;
    };

export type DashboardRow = {
  id: number;
  drop_id: number;
  name: string;
  spec_json: string;
  created_at: number;
  updated_at: number;
};

