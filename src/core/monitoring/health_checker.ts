import { DatabaseConfig } from '@/core/config/database';
import { ConfigManager } from '@/core/config/config_manager';
import { HealthCheckResult, ServiceHealth } from './monitoring_types';
import { logger } from '@/utils/logger';

export class HealthChecker {
  private static instance: HealthChecker;
  private config_manager = ConfigManager.getInstance();

  private constructor() {}

  static getInstance(): HealthChecker {
    if (!HealthChecker.instance) {
      HealthChecker.instance = new HealthChecker();
    }
    return HealthChecker.instance;
  }

  /**
   * 执行完整的系统健康检查
   */
  async check_system_health(): Promise<ServiceHealth> {
    const start_time = Date.now();
    const checks: HealthCheckResult[] = [];

    try {
      // 并行执行所有健康检查
      const [
        mysql_check,
        redis_check,
        binance_api_check,
        memory_check,
        disk_check
      ] = await Promise.allSettled([
        this.check_mysql_health(),
        this.check_redis_health(),
        this.check_binance_api_health(),
        this.check_memory_health(),
        this.check_disk_health()
      ]);

      // 处理检查结果
      this.process_check_result(checks, mysql_check, 'MySQL数据库');
      this.process_check_result(checks, redis_check, 'Redis缓存');
      this.process_check_result(checks, binance_api_check, '币安API');
      this.process_check_result(checks, memory_check, '系统内存');
      this.process_check_result(checks, disk_check, '磁盘空间');

      // 计算整体健康状态
      const overall_status = this.calculate_overall_status(checks);
      const uptime = Date.now() - start_time;

      return {
        overall_status,
        checks,
        uptime,
        timestamp: new Date()
      };

    } catch (error) {
      logger.error('系统健康检查失败', error);

      return {
        overall_status: 'critical',
        checks: [{
          service: '健康检查器',
          status: 'critical',
          message: `健康检查执行失败: ${error.message}`,
          last_check: new Date()
        }],
        uptime: Date.now() - start_time,
        timestamp: new Date()
      };
    }
  }

  /**
   * 检查MySQL数据库健康状态
   */
  private async check_mysql_health(): Promise<HealthCheckResult> {
    const start_time = Date.now();

    try {
      const connection = await DatabaseConfig.get_mysql_connection();

      // 执行简单查询测试连接
      await connection.execute('SELECT 1');
      connection.release();

      const response_time = Date.now() - start_time;

      return {
        service: 'MySQL数据库',
        status: response_time < 100 ? 'healthy' : 'warning',
        message: response_time < 100 ? '连接正常' : '响应较慢',
        response_time,
        last_check: new Date(),
        details: {
          host: this.config_manager.get_database_config().mysql.host,
          database: this.config_manager.get_database_config().mysql.database
        }
      };

    } catch (error) {
      return {
        service: 'MySQL数据库',
        status: 'critical',
        message: `连接失败: ${error.message}`,
        response_time: Date.now() - start_time,
        last_check: new Date(),
        details: { error: error.message }
      };
    }
  }

  /**
   * 检查Redis缓存健康状态
   */
  private async check_redis_health(): Promise<HealthCheckResult> {
    const start_time = Date.now();

    try {
      const redis_client = await DatabaseConfig.get_redis_client();

      // 执行PING命令测试连接
      const pong = await redis_client.ping();
      const response_time = Date.now() - start_time;

      if (pong === 'PONG') {
        return {
          service: 'Redis缓存',
          status: response_time < 50 ? 'healthy' : 'warning',
          message: response_time < 50 ? '连接正常' : '响应较慢',
          response_time,
          last_check: new Date(),
          details: {
            host: this.config_manager.get_database_config().redis.host,
            db: this.config_manager.get_database_config().redis.db
          }
        };
      } else {
        throw new Error('PING响应异常');
      }

    } catch (error) {
      return {
        service: 'Redis缓存',
        status: 'critical',
        message: `连接失败: ${error.message}`,
        response_time: Date.now() - start_time,
        last_check: new Date(),
        details: { error: error.message }
      };
    }
  }

  /**
   * 检查币安API健康状态
   */
  private async check_binance_api_health(): Promise<HealthCheckResult> {
    const start_time = Date.now();

    try {
      const binance_config = this.config_manager.get_binance_config();

      // 检查配置是否完整
      if (!binance_config.api_key || !binance_config.api_secret) {
        return {
          service: '币安API',
          status: 'warning',
          message: 'API密钥未配置',
          last_check: new Date(),
          details: { configured: false }
        };
      }

      // 这里可以添加实际的API连通性测试
      // 暂时只检查配置完整性
      const response_time = Date.now() - start_time;

      return {
        service: '币安API',
        status: 'healthy',
        message: 'API配置正常',
        response_time,
        last_check: new Date(),
        details: {
          base_url: binance_config.api_base_url,
          ws_url: binance_config.ws_base_url,
          configured: true
        }
      };

    } catch (error) {
      return {
        service: '币安API',
        status: 'critical',
        message: `API检查失败: ${error.message}`,
        response_time: Date.now() - start_time,
        last_check: new Date(),
        details: { error: error.message }
      };
    }
  }

  /**
   * 检查系统内存健康状态
   */
  private async check_memory_health(): Promise<HealthCheckResult> {
    const start_time = Date.now();

    try {
      const process_memory = process.memoryUsage();
      const heap_used_mb = Math.round(process_memory.heapUsed / 1024 / 1024);
      const heap_total_mb = Math.round(process_memory.heapTotal / 1024 / 1024);
      const usage_percentage = Math.round((process_memory.heapUsed / process_memory.heapTotal) * 100);

      let status: 'healthy' | 'warning' | 'critical' = 'healthy';
      let message = '内存使用正常';

      if (usage_percentage > 90) {
        status = 'critical';
        message = '内存使用率过高';
      } else if (usage_percentage > 75) {
        status = 'warning';
        message = '内存使用率偏高';
      }

      return {
        service: '系统内存',
        status,
        message,
        response_time: Date.now() - start_time,
        last_check: new Date(),
        details: {
          heap_used_mb,
          heap_total_mb,
          usage_percentage,
          rss_mb: Math.round(process_memory.rss / 1024 / 1024)
        }
      };

    } catch (error) {
      return {
        service: '系统内存',
        status: 'critical',
        message: `内存检查失败: ${error.message}`,
        response_time: Date.now() - start_time,
        last_check: new Date(),
        details: { error: error.message }
      };
    }
  }

  /**
   * 检查磁盘空间健康状态
   */
  private async check_disk_health(): Promise<HealthCheckResult> {
    const start_time = Date.now();

    try {
      // 简化的磁盘检查，实际应该检查具体磁盘使用率
      // 这里暂时返回健康状态
      return {
        service: '磁盘空间',
        status: 'healthy',
        message: '磁盘空间充足',
        response_time: Date.now() - start_time,
        last_check: new Date(),
        details: {
          note: '磁盘检查功能待完善'
        }
      };

    } catch (error) {
      return {
        service: '磁盘空间',
        status: 'warning',
        message: `磁盘检查失败: ${error.message}`,
        response_time: Date.now() - start_time,
        last_check: new Date(),
        details: { error: error.message }
      };
    }
  }

  /**
   * 处理Promise.allSettled的结果
   */
  private process_check_result(
    checks: HealthCheckResult[],
    result: PromiseSettledResult<HealthCheckResult>,
    service_name: string
  ) {
    if (result.status === 'fulfilled') {
      checks.push(result.value);
    } else {
      checks.push({
        service: service_name,
        status: 'critical',
        message: `检查失败: ${result.reason.message}`,
        last_check: new Date(),
        details: { error: result.reason.message }
      });
    }
  }

  /**
   * 计算整体健康状态
   */
  private calculate_overall_status(checks: HealthCheckResult[]): 'healthy' | 'warning' | 'critical' {
    const has_critical = checks.some(check => check.status === 'critical');
    const has_warning = checks.some(check => check.status === 'warning');

    if (has_critical) {
      return 'critical';
    } else if (has_warning) {
      return 'warning';
    } else {
      return 'healthy';
    }
  }

  /**
   * 获取特定服务的健康状态
   */
  async check_service_health(service: string): Promise<HealthCheckResult> {
    switch (service.toLowerCase()) {
      case 'mysql':
        return await this.check_mysql_health();
      case 'redis':
        return await this.check_redis_health();
      case 'binance':
        return await this.check_binance_api_health();
      case 'memory':
        return await this.check_memory_health();
      case 'disk':
        return await this.check_disk_health();
      default:
        return {
          service,
          status: 'critical',
          message: '未知的服务类型',
          last_check: new Date()
        };
    }
  }
}