-- ======================================================================
-- OI快照数据迁移脚本：从单表迁移到日期分表
-- ======================================================================
-- 目的：将 open_interest_snapshots 中的历史数据按日期迁移到独立的日期表
-- 适用场景：系统从单表结构升级到日期分表结构
-- 执行时间：根据数据量，预计10-30分钟（214万数据）
-- 注意：迁移完成后，原表数据仍保留，可手动删除或重命名备份
-- ======================================================================

-- 查看当前数据统计
SELECT '=== 当前数据统计 ===' as info;
SELECT
    DATE(snapshot_time) as date,
    COUNT(*) as record_count,
    COUNT(DISTINCT symbol) as symbol_count,
    MIN(snapshot_time) as earliest_time,
    MAX(snapshot_time) as latest_time
FROM open_interest_snapshots
GROUP BY DATE(snapshot_time)
ORDER BY date DESC;

-- ======================================================================
-- 步骤1：创建所有需要的日期表
-- ======================================================================

-- 生成创建表的SQL（需要根据实际日期调整）
-- 示例：手动创建最近7天的日期表

-- 创建函数：自动创建日期表
DELIMITER $$

DROP PROCEDURE IF EXISTS create_daily_table$$

CREATE PROCEDURE create_daily_table(IN table_date DATE)
BEGIN
    DECLARE table_name VARCHAR(100);
    DECLARE table_comment VARCHAR(200);

    -- Generate table name
    SET table_name = CONCAT('open_interest_snapshots_', DATE_FORMAT(table_date, '%Y%m%d'));
    SET table_comment = CONCAT('OI snapshots - ', DATE_FORMAT(table_date, '%Y-%m-%d'));

    -- 检查表是否已存在
    SET @check_sql = CONCAT('SELECT COUNT(*) INTO @table_exists
                             FROM information_schema.TABLES
                             WHERE TABLE_SCHEMA = DATABASE()
                             AND TABLE_NAME = ''', table_name, '''');
    PREPARE stmt FROM @check_sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;

    IF @table_exists = 0 THEN
        -- 创建日期表（包含data_source字段）
        SET @create_sql = CONCAT('
            CREATE TABLE ', table_name, ' (
                id BIGINT PRIMARY KEY AUTO_INCREMENT,
                symbol VARCHAR(20) NOT NULL,
                open_interest DECIMAL(30,8) NOT NULL,
                timestamp_ms BIGINT NOT NULL,
                snapshot_time TIMESTAMP NOT NULL,
                data_source VARCHAR(20) DEFAULT ''binance'',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                UNIQUE KEY uk_symbol_timestamp (symbol, timestamp_ms),
                INDEX idx_snapshot_time (snapshot_time),
                INDEX idx_symbol (symbol),
                INDEX idx_snapshot_symbol (snapshot_time, symbol, timestamp_ms, open_interest)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT=''', table_comment, '''
        ');

        PREPARE stmt FROM @create_sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;

        SELECT CONCAT('✓ 已创建表: ', table_name) as result;
    ELSE
        SELECT CONCAT('⊙ 表已存在: ', table_name) as result;
    END IF;
END$$

DELIMITER ;

-- ======================================================================
-- 步骤2：批量创建最近7天的日期表
-- ======================================================================

CALL create_daily_table(CURDATE() - INTERVAL 6 DAY);
CALL create_daily_table(CURDATE() - INTERVAL 5 DAY);
CALL create_daily_table(CURDATE() - INTERVAL 4 DAY);
CALL create_daily_table(CURDATE() - INTERVAL 3 DAY);
CALL create_daily_table(CURDATE() - INTERVAL 2 DAY);
CALL create_daily_table(CURDATE() - INTERVAL 1 DAY);
CALL create_daily_table(CURDATE());
CALL create_daily_table(CURDATE() + INTERVAL 1 DAY); -- 明天的表

-- ======================================================================
-- 步骤3：迁移数据到日期表
-- ======================================================================

-- 创建迁移存储过程
DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_oi_data$$

CREATE PROCEDURE migrate_oi_data(IN migrate_date DATE)
BEGIN
    DECLARE table_name VARCHAR(100);
    DECLARE start_time TIMESTAMP;
    DECLARE end_time TIMESTAMP;
    DECLARE affected_rows INT;

    -- 生成表名
    SET table_name = CONCAT('open_interest_snapshots_', DATE_FORMAT(migrate_date, '%Y%m%d'));

    -- 设置时间范围
    SET start_time = TIMESTAMP(migrate_date, '00:00:00');
    SET end_time = TIMESTAMP(migrate_date, '23:59:59');

    -- 检查目标表是否存在
    SET @check_sql = CONCAT('SELECT COUNT(*) INTO @table_exists
                             FROM information_schema.TABLES
                             WHERE TABLE_SCHEMA = DATABASE()
                             AND TABLE_NAME = ''', table_name, '''');
    PREPARE stmt FROM @check_sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;

    IF @table_exists = 0 THEN
        SELECT CONCAT('✗ 目标表不存在: ', table_name) as error;
    ELSE
        -- 迁移数据
        SET @migrate_sql = CONCAT('
            INSERT IGNORE INTO ', table_name, '
            (symbol, open_interest, timestamp_ms, snapshot_time, data_source)
            SELECT
                symbol,
                open_interest,
                timestamp_ms,
                snapshot_time,
                COALESCE(data_source, ''binance'')
            FROM open_interest_snapshots
            WHERE snapshot_time >= ''', start_time, '''
            AND snapshot_time <= ''', end_time, '''
        ');

        PREPARE stmt FROM @migrate_sql;
        EXECUTE stmt;
        SET affected_rows = ROW_COUNT();
        DEALLOCATE PREPARE stmt;

        SELECT CONCAT('✓ ', migrate_date, ' 迁移完成，迁移了 ', affected_rows, ' 条记录到表 ', table_name) as result;
    END IF;
END$$

DELIMITER ;

-- ======================================================================
-- 步骤4：执行数据迁移
-- ======================================================================

SELECT '=== 开始迁移数据 ===' as info;

-- 迁移最近7天的数据
CALL migrate_oi_data(CURDATE() - INTERVAL 6 DAY);
CALL migrate_oi_data(CURDATE() - INTERVAL 5 DAY);
CALL migrate_oi_data(CURDATE() - INTERVAL 4 DAY);
CALL migrate_oi_data(CURDATE() - INTERVAL 3 DAY);
CALL migrate_oi_data(CURDATE() - INTERVAL 2 DAY);
CALL migrate_oi_data(CURDATE() - INTERVAL 1 DAY);
CALL migrate_oi_data(CURDATE());

SELECT '=== 数据迁移完成 ===' as info;

-- ======================================================================
-- 步骤5：验证迁移结果
-- ======================================================================

SELECT '=== 验证迁移结果 ===' as info;

-- 检查新表数据统计
SET @today = CURDATE();
SET @table_name = CONCAT('open_interest_snapshots_', DATE_FORMAT(@today, '%Y%m%d'));

SET @verify_sql = CONCAT('
    SELECT
        ''', @today, ''' as date,
        COUNT(*) as new_table_records,
        COUNT(DISTINCT symbol) as symbols
    FROM ', @table_name
);

PREPARE stmt FROM @verify_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 对比原表今天的数据量
SELECT
    DATE(snapshot_time) as date,
    COUNT(*) as original_table_records,
    COUNT(DISTINCT symbol) as symbols
FROM open_interest_snapshots
WHERE DATE(snapshot_time) = CURDATE()
GROUP BY DATE(snapshot_time);

-- ======================================================================
-- 步骤6：清理说明（手动执行）
-- ======================================================================

SELECT '=== 清理说明 ===' as info;
SELECT '
迁移完成后，请手动执行以下操作：

1. 确认新表数据正确后，可以重命名或删除原表：
   -- 重命名原表（推荐，保留备份）
   RENAME TABLE open_interest_snapshots TO open_interest_snapshots_backup;

   -- 或直接删除原表（危险，请先确认）
   -- DROP TABLE open_interest_snapshots;

2. 确认应用程序已切换到新的日期分表逻辑

3. 清理存储过程：
   DROP PROCEDURE IF EXISTS create_daily_table;
   DROP PROCEDURE IF EXISTS migrate_oi_data;
' as instructions;

-- ======================================================================
-- 完成
-- ======================================================================
SELECT 'Migration script completed. Please review results before cleanup.' as status;
