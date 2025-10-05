export interface SystemMetrics {
  timestamp: Date;
  uptime: number;
  memory: {
    used: number;
    total: number;
    free: number;
    usage_percentage: number;
  };
  cpu: {
    usage_percentage: number;
    load_average: number[];
  };
  database: {
    mysql: {
      active_connections: number;
      max_connections: number;
      connection_usage_percentage: number;
      query_count: number;
      avg_query_time: number;
    };
    redis: {
      connected: boolean;
      memory_used: number;
      key_count: number;
      hit_rate: number;
    };
  };
  api: {
    request_count: number;
    error_count: number;
    avg_response_time: number;
    active_connections: number;
  };
  websocket: {
    connected: boolean;
    subscribed_streams: number;
    message_count: number;
    reconnect_count: number;
  };
  oi_monitoring: {
    active_symbols: number;
    polling_interval: number;
    last_update: Date | null;
    error_count: number;
    is_running: boolean;
  };
}

export interface HealthCheckResult {
  service: string;
  status: 'healthy' | 'warning' | 'critical';
  message: string;
  response_time?: number;
  last_check: Date;
  details?: any;
}

export interface ServiceHealth {
  overall_status: 'healthy' | 'warning' | 'critical';
  checks: HealthCheckResult[];
  uptime: number;
  timestamp: Date;
}

export interface PerformanceAlert {
  id: string;
  type: 'memory' | 'cpu' | 'database' | 'api' | 'websocket';
  severity: 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: Date;
  resolved: boolean;
}

export interface MonitoringConfig {
  collection_interval: number;
  health_check_interval: number;
  metrics_retention_hours: number;
  alert_thresholds: {
    memory_usage: number;
    cpu_usage: number;
    mysql_connection_usage: number;
    api_response_time: number;
    redis_memory_mb: number;
  };
}